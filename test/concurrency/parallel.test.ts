import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

type JsonRecord = Record<string, any>;
import type { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import {
  startTestApp,
  createWalletHttp,
  submitHttp,
  setupConcurrencyDb,
  cleanConcurrencyDb,
  teardownConcurrencyDb,
  assertBalanceMatchesLedger,
  ledgerCount,
} from './helpers.ts';
import { WagerTransactionKind } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity.ts';

/**
 * Real parallelism: every request below hits a live NestJS application over
 * HTTP and competes for the same PostgreSQL connection pool. There are no
 * sequential mocks and no in-memory idempotency caches.
 */
describe('Concurrency — real parallel HTTP requests', () => {
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

  async function open(id: string, playerId: string, amount = '100.00') {
    const res = await createWalletHttp(baseUrl, { id, playerId, amount });
    expect(res.status).toBe(201);
  }

  it('1. 50 identical bets in parallel produce a single debit', async () => {
    const walletId = 'aaaaaaaa-0001-4001-8001-000000000001';
    await open(walletId, 'parallel-player-1');

    const body = {
      providerId: 'provider-1',
      externalTransactionId: 'parallel-bet-1',
      walletId,
      playerId: 'parallel-player-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    };

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submitHttp(baseUrl, body)),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const payloads = (await Promise.all(responses.map((r) => r.json()))) as JsonRecord[];
    expect(payloads.filter((p) => p.idempotentReplay === false)).toHaveLength(1);
    expect(payloads.filter((p) => p.idempotentReplay === true)).toHaveLength(49);
    expect(new Set(payloads.map((p) => p.transactionId)).size).toBe(1);

    // Exactly one BET ledger entry (plus the OPENING entry): no double debit.
    expect(await ledgerCount(orm, walletId)).toBe(2);
    const invariant = await assertBalanceMatchesLedger(orm, walletId);
    expect(invariant.balance).toBe('70.00');
    expect(invariant.reconstructed).toBe(70);
  });

  it('2. concurrent bets competing for the same wallet: one wins, one is rejected', async () => {
    const walletId = 'aaaaaaaa-0002-4002-8002-000000000002';
    await open(walletId, 'parallel-player-2');

    const responses = await Promise.all([
      submitHttp(baseUrl, {
        providerId: 'provider-1',
        externalTransactionId: 'contention-a',
        walletId,
        playerId: 'parallel-player-2',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
      submitHttp(baseUrl, {
        providerId: 'provider-1',
        externalTransactionId: 'contention-b',
        walletId,
        playerId: 'parallel-player-2',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
    ]);

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 422]);

    const bodies = (await Promise.all(responses.map((r) => r.json()))) as JsonRecord[];
    const rejected = bodies.find((b) => b.code === 'INSUFFICIENT_BALANCE');
    expect(rejected).toBeDefined();

    // Only one debit was applied; the losing transaction left no ledger row.
    expect(await ledgerCount(orm, walletId)).toBe(2);
    const invariant = await assertBalanceMatchesLedger(orm, walletId);
    expect(invariant.balance).toBe('20.00');
    expect(invariant.reconstructed).toBe(20);
  });

  it('3. distinct wallets are processed in parallel without blocking each other', async () => {
    const wallets = Array.from({ length: 4 }, (_, i) => ({
      id: `bbbbbbbb-000${i}-4003-8003-00000000000${i}`,
      playerId: `parallel-player-w${i}`,
    }));

    for (const w of wallets) await open(w.id, w.playerId);

    const started = Date.now();
    const responses = await Promise.all(
      wallets.map((w, i) =>
        submitHttp(baseUrl, {
          providerId: 'provider-1',
          externalTransactionId: `distinct-bet-${i}`,
          walletId: w.id,
          playerId: w.playerId,
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        }),
      ),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as JsonRecord[];
    expect(bodies.every((b) => b.status === 'PROCESSED')).toBe(true);

    for (const w of wallets) {
      expect(await ledgerCount(orm, w.id)).toBe(2);
      const invariant = await assertBalanceMatchesLedger(orm, w.id);
      expect(invariant.balance).toBe('90.00');
    }

    // No per-wallet lock should serialize the whole batch for 2 seconds.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('9. same key with a different amount conflicts; reordered keys still replay', async () => {
    const walletId = 'cccccccc-0009-4009-8009-000000000009';
    await open(walletId, 'parallel-player-9');

    const base = {
      providerId: 'provider-1',
      externalTransactionId: 'hash-bet',
      walletId,
      playerId: 'parallel-player-9',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    };

    const first = await submitHttp(baseUrl, base);
    expect(first.status).toBe(200);

    // Same idempotency key, different nested value: must NOT replay.
    const conflict = await submitHttp(baseUrl, {
      ...base,
      money: { amount: '99.00', currency: 'BRL' },
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as JsonRecord).code).toBe('IDEMPOTENCY_CONFLICT');

    // Same business payload, different JSON key order: must replay.
    const reordered = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'provider-1:hash-bet',
      },
      body: JSON.stringify({
        money: { currency: 'BRL', amount: '30.00' },
        kind: WagerTransactionKind.Bet,
        playerId: 'parallel-player-9',
        walletId,
        externalTransactionId: 'hash-bet',
        providerId: 'provider-1',
        roundId: 'round-1',
        gameId: 'game-001',
      }),
    });
    expect(reordered.status).toBe(200);
    expect(((await reordered.json()) as JsonRecord).idempotentReplay).toBe(true);

    // The conflict never touched the balance: one OPENING + one BET entry.
    expect(await ledgerCount(orm, walletId)).toBe(2);
    const invariant = await assertBalanceMatchesLedger(orm, walletId);
    expect(invariant.balance).toBe('70.00');
    expect(invariant.reconstructed).toBe(70);
  });
});
