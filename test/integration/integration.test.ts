import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { EntityManager, MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import {
  setupTestDb,
  cleanDb,
  teardownTestDb,
} from './db-helper';
import { Wallet } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet.entity.ts';
import { WagerTransaction } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity.ts';
import { WagerTransactionKind, WagerTransactionStatus } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity.ts';
import { WalletLedgerEntry } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.entity.ts';
import { Money } from '@/shared/domain/value-objects/money.ts';
import { LedgerDirection } from '@/shared/domain/value-objects/ledger-direction.ts';

// Primary keys are UUID columns in PostgreSQL; the external/business
// identifiers (walletId, transactionId, playerId) remain plain strings.
const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const WALLET_ID_2 = '22222222-2222-4222-8222-222222222222';
const TX_ID_1 = '33333333-3333-4333-8333-333333333333';
const TX_ID_2 = '44444444-4444-4444-8444-444444444444';
const TX_ID_3 = '55555555-5555-4555-8555-555555555555';
const ENTRY_ID_1 = '66666666-6666-4666-8666-666666666666';
const ENTRY_ID_2 = '77777777-7777-4777-8777-777777777777';
const OPENING_TX_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPENING_TX_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPENING_TX_ID_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPENING_ENTRY_ID_2 = '88888888-8888-4888-8888-888888888888';
const OPENING_ENTRY_ID_3 = '99999999-9999-4999-8999-999999999999';

/** Mirrors the OPENING transaction written by OpenWalletUseCase. */
function openingTransaction(wallet: Wallet, id: string): WagerTransaction {
  return WagerTransaction.create({
    id,
    providerId: 'system',
    externalTransactionId: `opening:${wallet.id}`,
    idempotencyKey: `system:opening:${wallet.id}`,
    payloadHash: 'opening',
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'opening',
    gameId: 'system',
    kind: WagerTransactionKind.Opening,
    money: wallet.balance.toJSON(),
  });
}

/** Mirrors the OPENING ledger entry written by OpenWalletUseCase. */
function openingEntry(wallet: Wallet, id: string, transactionId: string): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id,
    walletId: wallet.id,
    transactionId,
    direction: LedgerDirection.Credit,
    money: wallet.balance.toJSON(),
    balanceBefore: Money.zero(wallet.currency).toJSON(),
    balanceAfter: wallet.balance.toJSON(),
  });
}

/** Persists the FK chain wallet -> opening transaction -> opening ledger entry. */
async function persistWalletWithOpening(
  em: EntityManager,
  wallet: Wallet,
  entryId: string,
  transactionId: string,
): Promise<void> {
  em.persist(wallet);
  await em.flush();
  const opening = openingTransaction(wallet, transactionId);
  opening.markProcessed(undefined, new Date());
  await persistTransactionWithEntry(em, opening, openingEntry(wallet, entryId, transactionId));
}

/** Persists a wager transaction before its ledger entry because FKs are raw UUIDs. */
async function persistTransactionWithEntry(
  em: EntityManager,
  tx: WagerTransaction,
  entry: WalletLedgerEntry,
): Promise<void> {
  em.persist(tx);
  await em.flush();
  em.persist(entry);
  await em.flush();
}

describe('Integration — database and domain', () => {
  let orm: MikroORM<PostgreSqlDriver>;

  beforeAll(async () => {
    orm = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb(orm);
  });

  beforeEach(async () => {
    await cleanDb(orm);
  });

  describe('Wallet creation', () => {
    it('should create wallet with initial balance and OPENING ledger entry', async () => {
      const em = orm.em;

      const wallet = Wallet.open({
        id: WALLET_ID,
        playerId: 'p-1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '1000.00', currency: 'BRL' }),
      });

      // The OPENING rows are created by OpenWalletUseCase; here we persist the
      // equivalent rows directly to exercise the real FK-constrained schema.
      await persistWalletWithOpening(em, wallet, ENTRY_ID_1, OPENING_TX_ID_1);

      const found = await em.findOne(Wallet, { id: WALLET_ID });
      expect(found).not.toBeNull();
      expect(found?.balance.amount).toBe('1000.00');
      expect(found?.version).toBe(1);

      // Ledger entry for OPENING
      const entries = await em.find(WalletLedgerEntry, { walletId: WALLET_ID });
      expect(entries.length).toBe(1);
      expect(entries[0].direction).toBe(LedgerDirection.Credit);
      expect(entries[0].money.amount).toBe('1000.00');
    });

    it('should reject duplicate wallet for same playerId + currency', async () => {
      const em = orm.em;

      const wallet1 = Wallet.open({
        id: WALLET_ID,
        playerId: 'p-1',
        currency: 'BRL',
        initialBalance: Money.zero('BRL'),
      });
      em.persist(wallet1);
      await em.flush();

      const wallet2 = Wallet.open({
        id: WALLET_ID_2,
        playerId: 'p-1',
        currency: 'BRL',
        initialBalance: Money.zero('BRL'),
      });
      em.persist(wallet2);

      // Unique constraint violation at DB level
      await expect(em.flush()).rejects.toThrow();
    });
  });

  describe('WagerTransaction lifecycle', () => {
    it('should process BET, WIN, and LOSS correctly', async () => {
      const em = orm.em;

      const wallet = Wallet.open({
        id: WALLET_ID,
        playerId: 'p-1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });
      await persistWalletWithOpening(em, wallet, OPENING_ENTRY_ID_2, OPENING_TX_ID_2);

      // BET 30.00
      const bet = WagerTransaction.create({
        id: TX_ID_1,
        providerId: 'prov-1',
        externalTransactionId: 'ext-1',
        idempotencyKey: 'prov-1:ext-1',
        payloadHash: 'hash-1',
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      });
      const debitResult = wallet.debit(bet.money);
      const entry = WalletLedgerEntry.create({
        id: ENTRY_ID_1,
        walletId: WALLET_ID,
        transactionId: TX_ID_1,
        direction: debitResult.direction,
        money: debitResult.money.toJSON(),
        balanceBefore: debitResult.balanceBefore.toJSON(),
        balanceAfter: debitResult.balanceAfter.toJSON(),
      });
      bet.markProcessed(undefined, new Date());
      await persistTransactionWithEntry(em, bet, entry);

      expect(wallet.balance.amount).toBe('70.00');
      expect(wallet.version).toBe(2);

      // WIN 20.00 referencing the BET
      const win = WagerTransaction.create({
        id: TX_ID_2,
        providerId: 'prov-1',
        externalTransactionId: 'ext-2',
        idempotencyKey: 'prov-1:ext-2',
        payloadHash: 'hash-2',
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Win,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: 'ext-1',
      });
      const creditResult = wallet.credit(win.money);
      const entry2 = WalletLedgerEntry.create({
        id: ENTRY_ID_2,
        walletId: WALLET_ID,
        transactionId: TX_ID_2,
        direction: creditResult.direction,
        money: creditResult.money.toJSON(),
        balanceBefore: creditResult.balanceBefore.toJSON(),
        balanceAfter: creditResult.balanceAfter.toJSON(),
      });
      win.markProcessed(TX_ID_1, new Date());
      await persistTransactionWithEntry(em, win, entry2);

      expect(wallet.balance.amount).toBe('90.00');

      // LOSS 10.00 (no balance change, no ledger)
      const loss = WagerTransaction.create({
        id: TX_ID_3,
        providerId: 'prov-1',
        externalTransactionId: 'ext-3',
        idempotencyKey: 'prov-1:ext-3',
        payloadHash: 'hash-3',
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Loss,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'ext-1',
      });
      loss.markProcessed(TX_ID_1, new Date());
      em.persist(loss);
      await em.flush();

      expect(wallet.balance.amount).toBe('90.00'); // unchanged

      // Ledger entries: OPENING(100) + BET debit(30) + WIN credit(20) = 3 entries
      const entries = await em.find(WalletLedgerEntry, { walletId: WALLET_ID });
      expect(entries.length).toBe(3);
    });

    it('should reject BET with insufficient balance', async () => {
      const em = orm.em;

      const wallet = Wallet.open({
        id: WALLET_ID,
        playerId: 'p-1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
      });
      em.persist(wallet);
      await em.flush();

      const bet = WagerTransaction.create({
        id: TX_ID_1,
        providerId: 'prov-1',
        externalTransactionId: 'ext-1',
        idempotencyKey: 'prov-1:ext-1',
        payloadHash: 'hash-1',
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '100.00', currency: 'BRL' },
      });

      expect(() => wallet.debit(bet.money)).toThrow();
      expect(wallet.balance.amount).toBe('50.00'); // unchanged
      expect(wallet.version).toBe(1); // no version bump
    });
  });

  describe('Idempotency', () => {
    it('should reject same idempotency key with different payload', async () => {
      const em = orm.em;

      const wallet = Wallet.open({
        id: WALLET_ID,
        playerId: 'p-1',
        currency: 'BRL',
        initialBalance: Money.zero('BRL'),
      });
      em.persist(wallet);
      await em.flush();

      const tx1 = WagerTransaction.create({
        id: TX_ID_1,
        providerId: 'prov-1',
        externalTransactionId: 'ext-1',
        idempotencyKey: 'prov-1:ext-1',
        payloadHash: 'hash-A',
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      });
      tx1.markProcessed(undefined, new Date());
      em.persist(tx1);
      await em.flush();

      const tx2 = WagerTransaction.create({
        id: TX_ID_2,
        providerId: 'prov-1',
        externalTransactionId: 'ext-1',
        idempotencyKey: 'prov-1:ext-1',
        payloadHash: 'hash-B', // different hash
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '99.00', currency: 'BRL' },
      });

      // Same idempotencyKey → unique constraint violation
      em.persist(tx2);
      await expect(em.flush()).rejects.toThrow();
    });
  });

  describe('REFUND / ROLLBACK', () => {
    it('should REFUND a processed BET (credit)', async () => {
      const em = orm.em;

      const wallet = Wallet.open({
        id: WALLET_ID,
        playerId: 'p-1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });
      em.persist(wallet);
      await em.flush();

      const bet = WagerTransaction.create({
        id: TX_ID_1,
        providerId: 'prov-1',
        externalTransactionId: 'ext-bet',
        idempotencyKey: 'prov-1:ext-bet',
        payloadHash: 'hash-bet',
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '40.00', currency: 'BRL' },
      });
      const debitResult = wallet.debit(bet.money);
      const entry = WalletLedgerEntry.create({
        id: ENTRY_ID_1,
        walletId: WALLET_ID,
        transactionId: TX_ID_1,
        direction: debitResult.direction,
        money: debitResult.money.toJSON(),
        balanceBefore: debitResult.balanceBefore.toJSON(),
        balanceAfter: debitResult.balanceAfter.toJSON(),
      });
      bet.markProcessed(undefined, new Date());
      await persistTransactionWithEntry(em, bet, entry);

      expect(wallet.balance.amount).toBe('60.00');

      // REFUND 40.00 referencing the BET
      const refund = WagerTransaction.create({
        id: TX_ID_2,
        providerId: 'prov-1',
        externalTransactionId: 'ext-refund',
        idempotencyKey: 'prov-1:ext-refund',
        payloadHash: 'hash-refund',
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'ext-bet',
      });
      const creditResult = wallet.credit(refund.money);
      const entry2 = WalletLedgerEntry.create({
        id: ENTRY_ID_2,
        walletId: WALLET_ID,
        transactionId: TX_ID_2,
        direction: creditResult.direction,
        money: creditResult.money.toJSON(),
        balanceBefore: creditResult.balanceBefore.toJSON(),
        balanceAfter: creditResult.balanceAfter.toJSON(),
      });
      refund.markProcessed(TX_ID_1, new Date());
      await persistTransactionWithEntry(em, refund, entry2);

      expect(wallet.balance.amount).toBe('100.00'); // restored

      const entries = await em.find(WalletLedgerEntry, { walletId: WALLET_ID });
      expect(entries.length).toBe(2); // debit + credit
    });
  });

  describe('Balance consistency invariant', () => {
    it('wallet.balance must equal ledger reconstruction', async () => {
      const em = orm.em;

      const wallet = Wallet.open({
        id: WALLET_ID,
        playerId: 'p-1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '200.00', currency: 'BRL' }),
      });
      await persistWalletWithOpening(em, wallet, OPENING_ENTRY_ID_3, OPENING_TX_ID_3);

      // BET 50.00
      const bet = WagerTransaction.create({
        id: TX_ID_1,
        providerId: 'prov-1',
        externalTransactionId: 'ext-1',
        idempotencyKey: 'prov-1:ext-1',
        payloadHash: 'hash-1',
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '50.00', currency: 'BRL' },
      });
      const d1 = wallet.debit(bet.money);
      const e1 = WalletLedgerEntry.create({
        id: ENTRY_ID_1,
        walletId: WALLET_ID,
        transactionId: TX_ID_1,
        direction: d1.direction,
        money: d1.money.toJSON(),
        balanceBefore: d1.balanceBefore.toJSON(),
        balanceAfter: d1.balanceAfter.toJSON(),
      });
      bet.markProcessed(undefined, new Date());
      await persistTransactionWithEntry(em, bet, e1);

      // WIN 30.00
      const win = WagerTransaction.create({
        id: TX_ID_2,
        providerId: 'prov-1',
        externalTransactionId: 'ext-2',
        idempotencyKey: 'prov-1:ext-2',
        payloadHash: 'hash-2',
        walletId: WALLET_ID,
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Win,
        money: { amount: '30.00', currency: 'BRL' },
      });
      const c1 = wallet.credit(win.money);
      const e2 = WalletLedgerEntry.create({
        id: ENTRY_ID_2,
        walletId: WALLET_ID,
        transactionId: TX_ID_2,
        direction: c1.direction,
        money: c1.money.toJSON(),
        balanceBefore: c1.balanceBefore.toJSON(),
        balanceAfter: c1.balanceAfter.toJSON(),
      });
      win.markProcessed(undefined, new Date());
      await persistTransactionWithEntry(em, win, e2);

      // Reconstruct from ledger
      const entries = await em.find(WalletLedgerEntry, { walletId: WALLET_ID });
      let reconstructed = Money.zero('BRL');
      for (const entry of entries) {
        if (entry.direction === 'CREDIT') {
          reconstructed = reconstructed.add(entry.money);
        } else {
          reconstructed = reconstructed.subtract(entry.money);
        }
      }

      expect(reconstructed.amount).toBe(wallet.balance.amount);
      expect(reconstructed.amount).toBe('180.00'); // 200 - 50 + 30
    });
  });
});
