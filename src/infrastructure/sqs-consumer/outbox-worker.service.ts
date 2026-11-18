import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

import type { OutboxRepository, UnitOfWork, Clock, Logger } from '@/shared/kernel/ports';
import {
  CLOCK,
  LOGGER,
  OUTBOX_REPOSITORY,
  UNIT_OF_WORK,
} from '@/shared/kernel/ports/tokens';
import { SQS_CLIENT, SQS_QUEUE_URL } from '@/infrastructure/messaging/sqs.tokens';
import { WorkerRuntime } from '@/shared/kernel/worker-runtime';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity';
import { MetricsService } from '@/shared/infrastructure/observability/metrics.service';

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private polling = false;
  private queueUrl: string | null = null;
  private pollIntervalMs = 2000;
  private maxAttempts = 10;
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SQS_QUEUE_URL) private readonly configuredQueueUrl: string,
    private readonly config: ConfigService,
    private readonly workerRuntime: WorkerRuntime,
    @Inject(OUTBOX_REPOSITORY) private readonly outboxRepo: OutboxRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueUrl = this.configuredQueueUrl || null;
    this.pollIntervalMs = Number(this.config.get<string>('OUTBOX_POLL_INTERVAL_MS', '2000'));
    this.maxAttempts = Number(this.config.get<string>('OUTBOX_MAX_ATTEMPTS', '10'));

    if (!this.workerRuntime.isEnabled('outbox')) {
      this.logger.info('Outbox publisher disabled by WORKER_ROLES');
      return;
    }
    if (!this.queueUrl) {
      this.logger.warn('SQS_QUEUE_URL not defined — outbox publisher disabled');
      return;
    }

    this.polling = true;
    this.pollLoop().catch((err) =>
      this.logger.error('Outbox worker loop failed', { error: String(err) }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.polling = false;
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch (err) {
        this.logger.warn('Outbox publisher did not finish cleanly', { error: String(err) });
      }
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      const task = this.processDue();
      this.inFlight = task;
      try {
        await task;
      } catch (err) {
        this.logger.error('Error in outbox worker', { error: String(err) });
      } finally {
        this.inFlight = undefined;
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  private async processDue(): Promise<void> {
    const now = this.clock.now();
    const messages = await this.outboxRepo.findPendingDue(now, 20);

    for (const msg of messages) {
      if (!this.polling) break;
      this.metrics.set(
        'outbox_lag_ms',
        Math.max(0, now.getTime() - msg.occurredAt.getTime()),
        { eventType: msg.eventType },
      );

      try {
        await this.publish(msg, now);
      } catch (err) {
        const attempt = msg.attemptsValue + 1;
        this.logger.error('Failed to publish outbox event', {
          outboxId: msg.id,
          eventType: msg.eventType,
          attempt,
          error: String(err),
        });
        this.metrics.inc('retries', { reason: 'outbox_publish' });

        try {
          if (attempt >= this.maxAttempts) {
            await this.uow.transactional(async (em) => {
              const fresh = await this.outboxRepo.lockById(msg.id, em);
              if (fresh && fresh.isPending()) {
                await this.outboxRepo.markDead(fresh, em);
              }
            });
            this.metrics.inc('dlq_messages', { reason: 'outbox' });
            this.logger.error('Outbox event moved to dead letter', {
              outboxId: msg.id,
              eventType: msg.eventType,
              attempts: attempt,
            });
          } else {
            await this.uow.transactional(async (em) => {
              const fresh = await this.outboxRepo.lockById(msg.id, em);
              if (fresh && fresh.isPending()) {
                await this.outboxRepo.scheduleRetry(fresh, this.clock.now(), em);
              }
            });
          }
        } catch (retryErr) {
          this.logger.error('Failed to update outbox retry state', {
            outboxId: msg.id,
            error: String(retryErr),
          });
        }
      }
    }
  }

  private async publish(msg: OutboxMessage, now: Date): Promise<void> {
    const payload = msg.getPayload();

    await this.uow.transactional(async (em) => {
      // Atomic claim: competing publishers serialize on this UPDATE and only
      // one receives the row. If the SQS send fails, the transaction rolls back
      // and the claim is released for the next poll.
      const fresh = await this.outboxRepo.lockUnpublishedById(msg.id, now, em);
      if (!fresh) return;

      const envelope = this.toEnvelope(msg, payload);

      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl!,
          MessageBody: JSON.stringify(envelope),
          // FIFO ordering is preserved per aggregate, not globally.
          MessageGroupId: `aggregate-${msg.aggregateId}`,
          // One outbox row = one publication attempt identity. Re-running the
          // worker after a crash cannot enqueue a different id for the same row.
          MessageDeduplicationId: msg.id,
          MessageAttributes: {
            eventType: { StringValue: msg.eventType, DataType: 'String' },
          },
        }),
      );

      // Same timestamp used by the SQL claim: no app/DB clock drift.
      await this.outboxRepo.markPublished(fresh, now, em);
      this.logger.info('Outbox event published', {
        outboxId: msg.id,
        eventType: msg.eventType,
        transactionId: msg.aggregateId,
      });
    });
  }

  /** Sends the full IntegrationEvent envelope with an explicit message contract. */
  private toEnvelope(msg: OutboxMessage, payload: Record<string, unknown>): Record<string, unknown> {
    const eventId = typeof payload.eventId === 'string' ? payload.eventId : msg.id;
    return {
      eventId,
      // Declared discriminator: the consumer never infers intent from data.
      messageKind: 'notification',
      type: 'IntegrationEvent',
      eventType: msg.eventType,
      aggregateId: msg.aggregateId,
      correlationId: payload.correlationId ?? eventId,
      ...(payload.causationId ? { causationId: payload.causationId } : {}),
      occurredAt:
        typeof payload.occurredAt === 'string'
          ? payload.occurredAt
          : msg.occurredAt.toISOString(),
      version: typeof payload.version === 'number' ? payload.version : 1,
      data: payload.data ?? payload,
    };
  }
}
