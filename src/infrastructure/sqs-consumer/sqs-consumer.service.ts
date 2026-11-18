import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
  Message,
} from '@aws-sdk/client-sqs';

import { SubmitWagerTransactionUseCase } from '@/modules/wagering/services/submit-wager-transaction.use-case';
import type { SubmitWagerTransactionInput } from '@/modules/wagering/services/submit-wager-transaction.use-case';
import type { InboxRepository } from '@/shared/kernel/ports';
import type { UnitOfWork } from '@/shared/kernel/ports';
import type { Logger } from '@/shared/kernel/ports';
import {
  INBOX_REPOSITORY,
  LOGGER,
  UNIT_OF_WORK,
} from '@/shared/kernel/ports/tokens';
import { SQS_CLIENT, SQS_QUEUE_URL } from '@/infrastructure/messaging/sqs.tokens';
import { WorkerRuntime } from '@/shared/kernel/worker-runtime';
import { InboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/inbox-message.entity';
import { canonicalHash } from '@/shared/domain/value-objects/canonical-hash';
import {
  DomainError,
  InvalidCommandMessageError,
  MessagePayloadChangedError,
  isBusinessRejection,
} from '@/shared/domain/errors/domain-error';
import { WagerTransactionKind, WagerTransactionStatus } from '@/shared/domain/rules/wager-rules';
import { MetricsService } from '@/shared/infrastructure/observability/metrics.service';
import { runWithLogContext } from '@/shared/kernel/providers/kernel-providers';

interface WagerEnvelope {
  messageId?: string;
  /** Declared message contract; routing never inspects the data shape. */
  messageKind?: 'command' | 'notification';
  type?: string;
  eventType?: string;
  occurredAt?: string;
  data?: Record<string, any>;
}

type ErrorKind = 'business' | 'permanent' | 'transient';
type RouteKind = 'command' | 'notification';

@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private queueUrl: string | undefined;
  private dlqUrl: string | undefined;
  private polling = false;
  private consumerName = 'wager-transaction-consumer';
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SQS_QUEUE_URL) private readonly configuredQueueUrl: string,
    private readonly config: ConfigService,
    private readonly workerRuntime: WorkerRuntime,
    private readonly submitUseCase: SubmitWagerTransactionUseCase,
    @Inject(INBOX_REPOSITORY) private readonly inboxRepo: InboxRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueUrl = this.configuredQueueUrl || undefined;
    this.dlqUrl = this.config.get<string>('SQS_DLQ_URL') || undefined;
    this.consumerName = this.config.get<string>('SQS_CONSUMER_NAME', 'wager-transaction-consumer');

    if (!this.workerRuntime.isEnabled('sqs-consumer')) {
      this.logger.info('SQS consumer disabled by WORKER_ROLES');
      return;
    }
    if (!this.queueUrl) {
      this.logger.warn('SQS_QUEUE_URL not defined — SQS consumer disabled');
      return;
    }

    this.polling = true;
    this.pollLoop().catch((err) =>
      this.logger.error('SQS consumer loop failed', { error: String(err) }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.polling = false;
    // Give an in-flight message a chance to commit and to be acked before the
    // process exits. If it cannot finish, visibility expiry redelivers it.
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch (err) {
        this.logger.warn('In-flight SQS message did not finish cleanly', { error: String(err) });
      }
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const task = this.pollOnce();
        this.inFlight = task;
        await task;
      } catch (err) {
        this.logger.error('Error consuming SQS messages', { error: String(err) });
        await new Promise((r) => setTimeout(r, 2000));
      } finally {
        this.inFlight = undefined;
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const res = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl!,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        MessageAttributeNames: ['All'],
      }),
    );

    for (const msg of res.Messages ?? []) {
      if (!this.polling) {
        // Return the undelivered message to the queue promptly on shutdown.
        await this.extendVisibility(msg);
        continue;
      }
      await this.handleMessage(msg);
    }
  }

  private async handleMessage(msg: Message): Promise<void> {
    const receiptHandle = msg.ReceiptHandle!;
    const body = msg.Body ?? '';
    const sqsMessageId = msg.MessageId ?? 'unknown';

    let envelope: WagerEnvelope;
    try {
      envelope = JSON.parse(body) as WagerEnvelope;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new Error('SQS body is not a JSON object');
      }
    } catch (err) {
      this.logger.error('Malformed SQS message — moving to DLQ', {
        messageId: sqsMessageId,
        error: String(err),
      });
      const moved = await this.toDlq(body, sqsMessageId, 'MALFORMED_MESSAGE');
      // Never ack a permanent failure that could not be parked in the DLQ.
      if (moved) await this.deleteMessage(receiptHandle);
      return;
    }

    const messageId = envelope.messageId || sqsMessageId;
    const data = envelope.data;

    await runWithLogContext(
      {
        messageId,
        correlationId: data?.idempotencyKey ?? messageId,
        providerId: data?.providerId,
        walletId: data?.walletId,
      },
      async () => {
        try {
          const result = await this.processMessage(messageId, envelope, data, body);
          if (result.status === WagerTransactionStatus.Rejected) {
            this.metrics.inc('transactions_by_status', { status: result.status });
          }
          await this.deleteMessage(receiptHandle);
          this.logger.info('SQS message acknowledged', {
            messageId,
            transactionId: result.transactionId,
            status: result.status,
            idempotentReplay: result.idempotentReplay,
          });
        } catch (err) {
          const kind = this.classifyError(err);
          this.logger.error('SQS message processing failed', {
            messageId,
            error: String(err),
          });

          if (kind === 'transient') {
            this.metrics.inc('retries', { reason: 'sqs_transient' });
            // No delete: SQS visibility timeout retries the message.
            return;
          }

          if (kind === 'business') {
            this.metrics.inc('transactions_by_status', { status: 'REJECTED' });
            // Business rejections are terminal outcomes, not delivery failures:
            // acknowledge them without publishing to the DLQ.
            await this.deleteMessage(receiptHandle);
            return;
          }

          const moved = await this.toDlq(
            body,
            messageId,
            (err as DomainError).code ?? 'PERMANENT_ERROR',
          );
          if (moved) await this.deleteMessage(receiptHandle);
        }
      },
    );
  }

  /**
   * Inbox row + financial writes + outbox events share one SQL transaction.
   * The SQS ack happens only after this transaction commits.
   */
  private async processMessage(
    messageId: string,
    envelopeOrBody: WagerEnvelope | string,
    data?: Record<string, any>,
    rawBody?: string,
  ) {
    // The two-argument form (messageId, rawBody) is kept for operators/tests that
    // invoke the consumer directly; the normal path passes a parsed envelope.
    const raw = rawBody ?? (typeof envelopeOrBody === 'string' ? envelopeOrBody : '');
    const envelope: WagerEnvelope =
      typeof envelopeOrBody === 'string'
        ? (JSON.parse(envelopeOrBody) as WagerEnvelope)
        : envelopeOrBody;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new InvalidCommandMessageError(messageId, 'envelope');
    }
    const payloadData = data ?? envelope.data;
    const payloadHash = canonicalHash(raw);

    return this.uow.transactional(async (em) => {
      const existing = await this.inboxRepo.findByMessage(this.consumerName, messageId, em);
      if (existing && !existing.matchesPayload(payloadHash)) {
        throw new MessagePayloadChangedError(messageId);
      }
      if (existing?.isProcessed()) {
        return { transactionId: '', status: 'ALREADY_PROCESSED', idempotentReplay: true };
      }

      const inboxMsg =
        existing ??
        InboxMessage.receive({
          messageId,
          consumerName: this.consumerName,
          payloadHash,
        });
      await this.inboxRepo.save(inboxMsg, em);

      if (this.routeMessage(envelope, messageId) === 'notification') {
        // Events produced by our own outbox share this queue: acknowledging a
        // notification has no financial effect, but the inbox row still makes
        // redelivery safe.
        inboxMsg.markProcessed(new Date());
        await this.inboxRepo.save(inboxMsg, em);
        return {
          transactionId: '',
          status: 'EVENT_ACKNOWLEDGED',
          idempotentReplay: false,
        };
      }

      const input = this.toInput(payloadData, messageId);
      const result = await this.submitUseCase.execute(input, { em });

      inboxMsg.markProcessed(new Date());
      await this.inboxRepo.save(inboxMsg, em);
      return result;
    });
  }

  /** Routing depends on the declared contract, never on payload field names. */
  private routeMessage(envelope: WagerEnvelope, messageId: string): RouteKind {
    if (envelope.messageKind === 'notification') return 'notification';
    if (
      envelope.messageKind === 'command' &&
      envelope.type === 'WagerTransactionRequested'
    ) {
      return 'command';
    }
    throw new InvalidCommandMessageError(messageId, 'messageKind/type');
  }

  private toInput(data: Record<string, any> | undefined, messageId: string): SubmitWagerTransactionInput {
    const required = [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'kind',
      'money',
    ] as const;
    for (const field of required) {
      if (data?.[field] === undefined || data[field] === null) {
        throw new InvalidCommandMessageError(messageId, field);
      }
    }
    if (
      typeof data!.money !== 'object' ||
      data!.money.amount === undefined ||
      data!.money.currency === undefined
    ) {
      throw new InvalidCommandMessageError(messageId, 'money.amount/currency');
    }

    const business = {
      providerId: data!.providerId,
      externalTransactionId: data!.externalTransactionId,
      playerId: data!.playerId,
      walletId: data!.walletId,
      roundId: data!.roundId,
      gameId: data!.gameId,
      kind: data!.kind as WagerTransactionKind,
      money: data!.money,
      referenceExternalTransactionId: data!.referenceExternalTransactionId,
    };
    return {
      ...business,
      idempotencyKey: data!.idempotencyKey ?? `${data!.providerId}:${data!.externalTransactionId}`,
      payloadHash: canonicalHash(business),
    };
  }

  private classifyError(err: unknown): ErrorKind {
    if (err instanceof DomainError) {
      return isBusinessRejection(err) ? 'business' : 'permanent';
    }
    return 'transient';
  }

  /** Returns false when the message must stay in the source queue for retry. */
  private async toDlq(body: string, messageId: string, reason: string): Promise<boolean> {
    if (!this.dlqUrl) {
      this.logger.warn('SQS_DLQ_URL not configured — permanent message not acknowledged', {
        messageId,
        reason,
      });
      this.metrics.inc('retries', { reason: 'dlq_unavailable' });
      return false;
    }
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.dlqUrl,
          MessageBody: body,
          MessageGroupId: 'wager-transactions-dlq',
          MessageDeduplicationId: `${messageId}:${reason}`,
          MessageAttributes: {
            reason: { StringValue: reason, DataType: 'String' },
            originalMessageId: { StringValue: messageId, DataType: 'String' },
          },
        }),
      );
      this.metrics.inc('dlq_messages', { reason });
      return true;
    } catch (err) {
      this.logger.error('Could not move message to DLQ', {
        messageId,
        reason,
        error: String(err),
      });
      this.metrics.inc('retries', { reason: 'dlq_send_failed' });
      return false;
    }
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl!, ReceiptHandle: receiptHandle }),
    );
  }

  private async extendVisibility(msg: Message): Promise<void> {
    if (!msg.ReceiptHandle) return;
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl!,
          ReceiptHandle: msg.ReceiptHandle,
          VisibilityTimeout: 60,
        }),
      );
    } catch (err) {
      this.logger.warn('Could not extend SQS visibility timeout', { error: String(err) });
    }
  }
}
