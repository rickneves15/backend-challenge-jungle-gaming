import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { spawn } from 'bun';
import type { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import {
  startTestApp,
  setupConcurrencyDb,
  cleanConcurrencyDb,
  teardownConcurrencyDb,
  buildServices,
  createWallet,
  submitTx,
  assertBalanceMatchesLedger,
  ledgerCount,
} from './helpers.ts';
import { WagerTransactionKind, WagerTransactionStatus } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity.ts';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity.ts';

describe('Concurrency — crash, contention and recovery scenarios', () => {
  let orm: MikroORM<PostgreSqlDriver>;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    orm = await setupConcurrencyDb();
    ({ app, baseUrl } = await startTestApp());
  });

  afterAll(async () => {
    await app.close();
    await teardownConcurrencyDb(orm);
  });

  beforeEach(async () => {
    await cleanConcurrencyDb(orm);
  });

  it('4. three independent OS processes compete for the same wallet', async () => {
    const walletId = 'dddddddd-0004-4004-8004-000000000004';
    const services = buildServices(orm);
    await createWallet(services, { id: walletId, playerId: 'mp-player', amount: '100.00' });

    const children = [0, 1, 2].map((i) =>
      spawn(
        [
          'bun',
          'test/concurrency/http-worker.ts',
          baseUrl,
          walletId,
          'mp-player',
          String(i),
          '10',
        ],
        { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' },
      ),
    );

    const outputs = await Promise.all(
      children.map(async (child) => {
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        const exitCode = await child.exited;
        return { stdout, stderr, exitCode };
      }),
    );

    for (const out of outputs) {
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toBe('');
    }
    const all = outputs.flatMap((o) => JSON.parse(o.stdout.trim()).results);
    expect(all).toHaveLength(30);
    expect(all.every((r: any) => r.status === 200)).toBe(true);
    expect(all.every((r: any) => r.body.status === 'PROCESSED')).toBe(true);

    // 30 debits of 1.00 from 100.00, one OPENING + 30 BET ledger entries.
    expect(await ledgerCount(orm, walletId)).toBe(31);
    const invariant = await assertBalanceMatchesLedger(orm, walletId);
    expect(invariant.balance).toBe('70.00');
  });

  it('5. worker dies after commit and before ack: redelivery causes no second debit', async () => {
    const walletId = 'dddddddd-0005-4005-8005-000000000005';
    const services = buildServices(orm);
    await createWallet(services, { id: walletId, playerId: 'ack-player', amount: '100.00' });

    const messageId = 'sqs-msg-committed-not-acked';
    const body = JSON.stringify({
      messageKind: 'command',
      type: 'WagerTransactionRequested',
      data: {
        providerId: 'provider-1',
        externalTransactionId: 'dead-ack-bet',
        idempotencyKey: 'provider-1:dead-ack-bet',
        payloadHash: 'dead-ack-hash',
        playerId: 'ack-player',
        walletId,
        roundId: 'round-1',
        gameId: 'game-001',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      },
    });

    // First delivery: inbox row + transaction commit. deleteMessage is never
    // called, simulating a process death between COMMIT and the SQS ack.
    await (services.consumer as any).processMessage(messageId, body);
    expect(await ledgerCount(orm, walletId)).toBe(2);

    // Redelivery of the same SQS MessageId: inbox must ack silently.
    await (services.consumer as any).processMessage(messageId, body);

    expect(await ledgerCount(orm, walletId)).toBe(2);
    const invariant = await assertBalanceMatchesLedger(orm, walletId);
    expect(invariant.balance).toBe('80.00');
  });

  it('6. two publishers racing on the same outbox row publish it once', async () => {
    const walletId = 'dddddddd-0006-4006-8006-000000000006';
    const services = buildServices(orm);
    // Zero balance and a LOSS create exactly one outbox row and no ledger row.
    await createWallet(services, { id: walletId, playerId: 'pub-player', amount: '0.00' });
    await submitTx(services, {
      walletId,
      playerId: 'pub-player',
      externalTransactionId: 'publisher-loss',
      kind: WagerTransactionKind.Loss,
      amount: '5.00',
    });

    const em = orm.em.fork();
    const rows = await em.find(OutboxMessage, { publishedAt: undefined });
    expect(rows.length).toBe(1);
    const targetId = rows[0].id;

    const sent: any[] = [];
    (services.outboxWorker as any).sqs = {
      send: async (cmd: any) => {
        sent.push(cmd);
        return {};
      },
    };
    const publish = (services.outboxWorker as any).publish.bind(services.outboxWorker);
    const now = new Date();
    await Promise.all([publish(rows[0], now), publish(rows[0], now)]);

    expect(sent).toHaveLength(1);
    expect(sent[0].input.MessageDeduplicationId).toBe(targetId);

    const published = await orm.em.fork().findOne(OutboxMessage, targetId);
    expect(published?.publishedAt).toBeDefined();

    const invariant = await assertBalanceMatchesLedger(orm, walletId);
    expect(invariant.balance).toBe('0.00');
  });

  it('7. REFUND delivered before its reference is retried and eventually settles', async () => {
    const walletId = 'dddddddd-0007-4007-8007-000000000007';
    const services = buildServices(orm);
    await createWallet(services, { id: walletId, playerId: 'ref-player', amount: '100.00' });

    const early = await submitTx(services, {
      walletId,
      playerId: 'ref-player',
      externalTransactionId: 'early-refund',
      kind: WagerTransactionKind.Refund,
      amount: '10.00',
      referenceExternalTransactionId: 'late-bet',
    });
    expect(early.status).toBe(WagerTransactionStatus.PendingReference);

    // The reference arrives later.
    const bet = await submitTx(services, {
      walletId,
      playerId: 'ref-player',
      externalTransactionId: 'late-bet',
      kind: WagerTransactionKind.Bet,
      amount: '10.00',
    });
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    // Trigger the scheduled sweep (public tick, same use case as production).
    const futureCutoff = new Date(Date.now() + 10 * 60 * 1000);
    const swept = await services.pendingWorker.tick(futureCutoff);
    expect(swept.processed).toBe(1);

    expect(await ledgerCount(orm, walletId)).toBe(3);
    const invariant = await assertBalanceMatchesLedger(orm, walletId);
    expect(invariant.balance).toBe('100.00');
  });

  it('8. state survives a full service restart (separate writer process)', async () => {
    const walletId = 'dddddddd-0008-4008-8008-000000000008';

    const writer = spawn(
      ['bun', 'test/concurrency/restart-writer.ts', walletId],
      { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = await new Response(writer.stdout).text();
    const stderr = await new Response(writer.stderr).text();
    expect(await writer.exited).toBe(0);
    const resultLine = stdout.split('\n').find((line) => line.startsWith('RESULT:'));
    expect(resultLine).toBeDefined();
    expect(JSON.parse(resultLine!.slice('RESULT:'.length)).written).toBe(true);
    expect(stderr).toBe('');

    // Close and reopen the ORM: a fresh process/connection sees the same data.
    await teardownConcurrencyDb(orm);
    orm = await setupConcurrencyDb();

    expect(await ledgerCount(orm, walletId)).toBe(3);
    const invariant = await assertBalanceMatchesLedger(orm, walletId);
    expect(invariant.balance).toBe('85.00');
  });

  it('10. outbox integration events are acked safely, with no financial effect', async () => {
    const walletId = 'dddddddd-0010-4010-8010-000000000010';
    const services = buildServices(orm);
    await createWallet(services, { id: walletId, playerId: 'event-player', amount: '100.00' });

    // Exact envelope produced by OutboxWorker.publish(): a notification, not a
    // WagerTransactionRequested command. It shares the inbound queue.
    const messageId = 'outbox-event-msg-001';
    const body = JSON.stringify({
      messageKind: 'notification',
      type: 'IntegrationEvent',
      eventId: 'event-001',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'tx-001',
      payload: {
        eventId: 'event-001',
        eventType: 'WagerTransactionProcessed',
        aggregateId: 'tx-001',
        version: 1,
        data: { transactionId: 'tx-001', walletId, money: { amount: '30.00', currency: 'BRL' } },
      },
      occurredAt: new Date().toISOString(),
    });

    // Must not throw (it used to crash on "data.idempotencyKey"), and a
    // redelivery must be deduplicated by the inbox.
    await (services.consumer as any).processMessage(messageId, body);
    await (services.consumer as any).processMessage(messageId, body);

    const { InboxMessage } = await import('@/shared/infrastructure/persistence/mikro-orm/entities/inbox-message.entity.ts');
    expect(await orm.em.fork().count(InboxMessage, { messageId })).toBe(1);
    expect(await ledgerCount(orm, walletId)).toBe(1); // only the OPENING entry
    const invariant = await assertBalanceMatchesLedger(orm, walletId);
    expect(invariant.balance).toBe('100.00');
  });
});
