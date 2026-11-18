import { describe, it, expect } from 'bun:test';

import { SubmitWagerTransactionUseCase } from '@/modules/wagering/services/submit-wager-transaction.use-case.ts';
import type { SubmitWagerTransactionInput } from '@/modules/wagering/services/submit-wager-transaction.use-case.ts';
import { WagerTransaction } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity.ts';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity.ts';
import { WagerTransactionKind, WagerTransactionStatus } from '@/shared/domain/rules/wager-rules.ts';

import {
  NOW,
  REFERENCE_ID,
  TX_ID,
  WALLET_ID,
  makeMetrics,
  makeUow,
  makeWallet,
  noopLogger,
} from './fixtures.ts';

function makeTransaction(input: SubmitWagerTransactionInput): WagerTransaction {
  return WagerTransaction.create({
    id: TX_ID,
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    idempotencyKey: input.idempotencyKey,
    payloadHash: input.payloadHash,
    walletId: input.walletId,
    playerId: input.playerId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money,
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  });
}

function makeReference(overrides: Partial<{ playerId: string; money: { amount: string; currency: string }; kind: WagerTransactionKind }> = {}) {
  const reference = WagerTransaction.create({
    id: REFERENCE_ID,
    providerId: 'provider-1',
    externalTransactionId: 'original-bet',
    idempotencyKey: 'provider-1:original-bet',
    payloadHash: 'reference-hash',
    walletId: WALLET_ID,
    playerId: overrides.playerId ?? 'player-1',
    roundId: 'round-1',
    gameId: 'game-001',
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    money: overrides.money ?? { amount: '20.00', currency: 'BRL' },
  });
  reference.markProcessed(undefined, NOW);
  return reference;
}

function baseInput(overrides: Partial<SubmitWagerTransactionInput> = {}): SubmitWagerTransactionInput {
  return {
    providerId: 'provider-1',
    externalTransactionId: 'refund-1',
    idempotencyKey: 'provider-1:refund-1',
    payloadHash: 'payload-hash-1',
    playerId: 'player-1',
    walletId: WALLET_ID,
    roundId: 'round-1',
    gameId: 'game-001',
    kind: WagerTransactionKind.Refund,
    money: { amount: '10.00', currency: 'BRL' },
    referenceExternalTransactionId: 'original-bet',
    ...overrides,
  };
}

function buildSubmit(overrides: {
  existing?: WagerTransaction | null;
  reference?: WagerTransaction | null;
  reversal?: WagerTransaction | null;
} = {}) {
  const wallet = makeWallet();
  const uow = makeUow();
  const savedOutbox: OutboxMessage[] = [];
  const txRepo = {
    findByIdempotencyKey: async () => overrides.existing ?? null,
    findByProviderAndExternal: async () => overrides.reference ?? null,
    findReversal: async () => overrides.reversal ?? null,
    save: async () => undefined,
  } as any;
  const usecase = new SubmitWagerTransactionUseCase(
    uow,
    { lockById: async () => wallet, save: async () => undefined } as any,
    txRepo,
    { save: async () => undefined } as any,
    { save: async (msg: OutboxMessage) => savedOutbox.push(msg) } as any,
    { now: () => NOW } as any,
    { generate: () => crypto.randomUUID() } as any,
    noopLogger,
    makeMetrics(),
  );
  return { usecase, wallet, savedOutbox };
}

describe('SubmitWagerTransactionUseCase — failure and replay contracts', () => {
  it('rejects an internal OPENING submission', async () => {
    const { usecase } = buildSubmit();
    const input = baseInput({ kind: WagerTransactionKind.Opening });

    await expect(usecase.execute(input)).rejects.toMatchObject({
      code: 'OPENING_NOT_SUBMITTABLE',
      statusCode: 400,
    });
  });

  it('rejects a reference from another player', async () => {
    const { usecase, savedOutbox } = buildSubmit({
      reference: makeReference({ playerId: 'another-player' }),
    });

    const result = await usecase.execute(baseInput());

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe('REFERENCE_MISMATCH');
    expect(savedOutbox.some((msg) => msg.eventType === 'WagerTransactionRejected')).toBe(true);
  });

  it('rejects a money value that differs from the reference', async () => {
    const { usecase } = buildSubmit({ reference: makeReference() });

    const result = await usecase.execute(baseInput());

    expect(result.failureCode).toBe('VALUE_MISMATCH');
    expect(result.reason).toContain('expected 20.00, received 10.00');
  });

  it('rejects a second reversal of the same reference', async () => {
    const existingReversal = makeTransaction(baseInput({
      externalTransactionId: 'first-refund',
      idempotencyKey: 'provider-1:first-refund',
    }));
    const { usecase } = buildSubmit({
      reference: makeReference(),
      reversal: existingReversal,
    });

    const result = await usecase.execute(baseInput());

    expect(result.failureCode).toBe('DUPLICATE_REFERENCE_REVERSAL');
  });

  it('exhausts pending-reference retries with a typed REFERENCE_NOT_FOUND', async () => {
    const exhausted = makeTransaction(baseInput());
    exhausted.markPendingReference();
    exhausted.referenceAttempts = 9;
    const { usecase, savedOutbox } = buildSubmit({ existing: exhausted });

    const result = await usecase.execute(baseInput());

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(result.reason).toContain('original-bet');
    expect(result.reason).toContain('provider-1');
    expect(savedOutbox.map((msg) => msg.eventType)).toContain('WagerTransactionRejected');
  });

  it('replays the persisted balance snapshot and rejection reason', async () => {
    const rejected = makeTransaction(baseInput({
      kind: WagerTransactionKind.Bet,
      externalTransactionId: 'rejected-bet',
      idempotencyKey: 'provider-1:rejected-bet',
    }));
    rejected.setBalanceSnapshot({ amount: '73.00', currency: 'BRL' });
    rejected.reject('INSUFFICIENT_BALANCE', NOW, 'original rejection reason');
    const { usecase, savedOutbox } = buildSubmit({ existing: rejected });

    const result = await usecase.execute(baseInput({
      kind: WagerTransactionKind.Bet,
      externalTransactionId: 'rejected-bet',
      idempotencyKey: 'provider-1:rejected-bet',
    }));

    expect(result.idempotentReplay).toBe(true);
    expect(result.balance).toEqual({ amount: '73.00', currency: 'BRL' });
    expect(result.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(result.reason).toBe('original rejection reason');
    expect(savedOutbox).toHaveLength(0);
  });
});
