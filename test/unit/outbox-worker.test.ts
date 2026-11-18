import { describe, it, expect } from 'bun:test';

import { OutboxWorker } from '@/infrastructure/sqs-consumer/outbox-worker.service.ts';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity.ts';
import { WorkerRuntime } from '@/shared/kernel/worker-runtime.ts';

import {
  NOW,
  WALLET_ID,
  makeConfig,
  makeMetrics,
  makeUow,
  noopLogger,
} from './fixtures.ts';

function buildOutboxWorker(maxAttempts: number) {
  const sent: any[] = [];
  const metrics = makeMetrics();
  const msg = OutboxMessage.enqueue({
    aggregateId: WALLET_ID,
    eventType: 'WagerTransactionProcessed',
    payload: { eventId: 'event-1' },
    occurredAt: new Date(NOW.getTime() - 60_000),
  });
  let dead = 0;
  let retried = 0;
  const outboxRepo = {
    findPendingDue: async () => [msg],
    lockUnpublishedById: async () => msg,
    lockById: async () => msg,
    markDead: async () => {
      dead += 1;
      msg.markDead();
    },
    scheduleRetry: async (_msg: OutboxMessage, at: Date) => {
      retried += 1;
      msg.scheduleRetry(at);
    },
  } as any;
  const config = makeConfig({
    OUTBOX_MAX_ATTEMPTS: String(maxAttempts),
    OUTBOX_POLL_INTERVAL_MS: '1000',
    WORKER_ROLES: '',
  });
  const worker = new OutboxWorker(
    { send: async (command: any) => { sent.push(command); throw new Error('sqs unavailable'); } } as any,
    'https://sqs.example/outbox',
    config,
    new WorkerRuntime(config),
    outboxRepo,
    makeUow(),
    { now: () => NOW } as any,
    noopLogger,
    metrics,
  );
  return { worker, msg, metrics, get dead() { return dead; }, get retried() { return retried; } };
}

describe('OutboxWorker — retry and dead-letter branches', () => {
  it('dead-letters an event once the attempt budget is exhausted', async () => {
    const { worker, msg, metrics } = buildOutboxWorker(1);
    msg.attempts = 9;
    await worker.onModuleInit();
    (worker as any).polling = true;

    await (worker as any).processDue();

    expect(msg.publishedAt).toBeUndefined();
    expect(msg.nextAttemptAt).toBeUndefined();
    expect(metrics.calls).toContainEqual({
      method: 'inc',
      name: 'dlq_messages',
      labels: { reason: 'outbox' },
    });
  });

  it('schedules a delayed retry while attempts remain', async () => {
    const result = buildOutboxWorker(10);
    const { worker, msg, metrics } = result;
    msg.attempts = 0;
    await worker.onModuleInit();
    (worker as any).polling = true;

    await (worker as any).processDue();

    expect(result.retried).toBe(1);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(msg.publishedAt).toBeUndefined();
    expect(metrics.calls).toContainEqual({
      method: 'inc',
      name: 'retries',
      labels: { reason: 'outbox_publish' },
    });
  });
});
