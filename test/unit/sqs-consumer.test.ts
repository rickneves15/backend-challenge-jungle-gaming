import { describe, it, expect } from 'bun:test';

import { SqsConsumerService } from '@/infrastructure/sqs-consumer/sqs-consumer.service.ts';
import { WorkerRuntime } from '@/shared/kernel/worker-runtime.ts';
import { DomainError, InsufficientBalanceError } from '@/shared/domain/errors/domain-error.ts';

import {
  WALLET_ID,
  makeConfig,
  makeMetrics,
  makeUow,
  noopLogger,
} from './fixtures.ts';

function buildSqsConsumer(dlqUrl: string | undefined) {
  const sent: any[] = [];
  const sqs = {
    send: async (command: any) => {
      sent.push(command);
      return {};
    },
  } as any;
  const metrics = makeMetrics();
  const config = makeConfig({
    SQS_DLQ_URL: dlqUrl,
    SQS_CONSUMER_NAME: 'test-consumer',
    WORKER_ROLES: '',
  });
  const consumer = new SqsConsumerService(
    sqs,
    'https://sqs.example/source',
    config,
    new WorkerRuntime(config),
    { execute: async () => undefined } as any,
    { findByMessage: async () => null, save: async () => undefined } as any,
    makeUow(),
    noopLogger,
    metrics,
  );
  return { consumer, sent, metrics };
}

describe('SqsConsumerService — error classification and DLQ safety', () => {
  it('classifies permanent, business and transient errors distinctly', async () => {
    const { consumer } = buildSqsConsumer('https://sqs.example/dlq');
    await consumer.onModuleInit();
    const classify = (consumer as any).classifyError.bind(consumer);

    expect(classify(new DomainError('OPENING_NOT_SUBMITTABLE', 'internal'))).toBe('permanent');
    expect(classify(new InsufficientBalanceError(WALLET_ID, '1.00', '2.00'))).toBe('business');
    expect(classify(new Error('database unavailable'))).toBe('transient');
  });

  it('does not report a DLQ move when the DLQ is unset', async () => {
    const { consumer, sent, metrics } = buildSqsConsumer(undefined);
    await consumer.onModuleInit();

    const moved = await (consumer as any).toDlq('raw body', 'msg-1', 'PERMANENT_ERROR');

    expect(moved).toBe(false);
    expect(sent).toHaveLength(0);
    expect(metrics.calls).toContainEqual({
      method: 'inc',
      name: 'retries',
      labels: { reason: 'dlq_unavailable' },
    });
  });

  it('acks a permanent failure only after it is parked in the DLQ', async () => {
    const { consumer, sent } = buildSqsConsumer('https://sqs.example/dlq');
    await consumer.onModuleInit();
    (consumer as any).processMessage = async () => {
      throw new DomainError('INVALID_COMMAND_MESSAGE', 'bad envelope');
    };

    await (consumer as any).handleMessage({
      MessageId: 'msg-permanent',
      ReceiptHandle: 'receipt-permanent',
      Body: JSON.stringify({ messageKind: 'command', type: 'WagerTransactionRequested', data: {} }),
    });

    expect(sent).toHaveLength(2);
    expect(sent[0].input.QueueUrl).toBe('https://sqs.example/dlq');
    expect(sent[0].input.MessageAttributes.reason.StringValue).toBe('INVALID_COMMAND_MESSAGE');
    expect(sent[1].input.ReceiptHandle).toBe('receipt-permanent');
  });

  it('acks a business rejection without publishing to the DLQ', async () => {
    const { consumer, sent } = buildSqsConsumer('https://sqs.example/dlq');
    await consumer.onModuleInit();
    (consumer as any).processMessage = async () => {
      throw new InsufficientBalanceError(WALLET_ID, '1.00', '2.00');
    };

    await (consumer as any).handleMessage({
      MessageId: 'msg-business',
      ReceiptHandle: 'receipt-business',
      Body: JSON.stringify({ messageKind: 'command', type: 'WagerTransactionRequested', data: {} }),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].input.ReceiptHandle).toBe('receipt-business');
  });
});
