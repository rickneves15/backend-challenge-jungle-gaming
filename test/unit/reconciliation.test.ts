import { describe, it, expect } from 'bun:test';

import { ReconcileWalletUseCase } from '@/modules/reconciliation/services/reconcile-wallet.use-case.ts';
import { WalletLedgerEntry } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.entity.ts';
import { Money } from '@/shared/domain/value-objects/money.ts';
import { LedgerDirection } from '@/shared/domain/value-objects/ledger-direction.ts';

import {
  LEDGER_ID,
  TX_ID,
  WALLET_ID,
  makeMetrics,
  makeUow,
  makeWallet,
  noopLogger,
} from './fixtures.ts';

describe('ReconcileWalletUseCase', () => {
  it('returns a consistent result and checks every ledger page', async () => {
    const wallet = makeWallet();
    const creditEntry = WalletLedgerEntry.create({
      id: LEDGER_ID,
      walletId: WALLET_ID,
      transactionId: TX_ID,
      direction: LedgerDirection.Credit,
      money: { amount: '100.00', currency: 'BRL' },
      balanceBefore: Money.zero('BRL').toJSON(),
      balanceAfter: Money.from({ amount: '100.00', currency: 'BRL' }).toJSON(),
    });
    const findByWalletCalls: Array<string | undefined> = [];
    const ledgerRepo = {
      findByWallet: async (_walletId: string, cursor: string | undefined) => {
        findByWalletCalls.push(cursor);
        if (cursor === undefined) {
          return { entries: [creditEntry], nextCursor: 'page-2' };
        }
        return { entries: [], nextCursor: undefined };
      },
    } as any;
    const uow = makeUow();
    const metrics = makeMetrics();
    const usecase = new ReconcileWalletUseCase(
      uow,
      { findById: async () => wallet } as any,
      ledgerRepo,
      noopLogger,
      metrics,
    );

    const result = await usecase.execute(WALLET_ID);

    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(1);
    expect(result.difference.amount).toBe('0.00');
    expect(findByWalletCalls).toEqual([undefined, 'page-2']);
    expect(String(uow.isolationLevel)).toContain('repeatable read');
  });

  it('counts a mismatch metric without leaking balances to logs', async () => {
    const wallet = makeWallet();
    const partialEntry = WalletLedgerEntry.create({
      id: LEDGER_ID,
      walletId: WALLET_ID,
      transactionId: TX_ID,
      direction: LedgerDirection.Credit,
      money: { amount: '60.00', currency: 'BRL' },
      balanceBefore: Money.zero('BRL').toJSON(),
      balanceAfter: Money.from({ amount: '60.00', currency: 'BRL' }).toJSON(),
    });
    const metrics = makeMetrics();
    const usecase = new ReconcileWalletUseCase(
      makeUow(),
      { findById: async () => wallet } as any,
      { findByWallet: async () => ({ entries: [partialEntry], nextCursor: undefined }) } as any,
      noopLogger,
      metrics,
    );

    const result = await usecase.execute(WALLET_ID);

    expect(result.consistent).toBe(false);
    expect(result.calculatedBalance.amount).toBe('60.00');
    expect(metrics.calls).toContainEqual({
      method: 'inc',
      name: 'reconciliation_mismatches',
      labels: { walletId: WALLET_ID },
    });
  });
});
