import { describe, it, expect } from 'bun:test';
import { Wallet } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet.entity';
import { Money } from '@/shared/domain/value-objects/money';
import { InsufficientBalanceError } from '@/shared/domain/errors/domain-error';
import { CurrencyMismatchError } from '@/shared/domain/errors/domain-error';
import { LedgerDirection } from '@/shared/domain/value-objects/ledger-direction';

describe('Wallet', () => {
  describe('open()', () => {
    it('should create a wallet with initial balance and version 1', () => {
      const wallet = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '1000.00', currency: 'BRL' }),
      });

      expect(wallet.id).toBe('w1');
      expect(wallet.playerId).toBe('p1');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.amount).toBe('1000.00');
      expect(wallet.version).toBe(1);
    });

    it('should reject a missing playerId', () => {
      expect(() =>
        Wallet.open({
          id: 'w1',
          playerId: '',
          currency: 'BRL',
          initialBalance: Money.zero('BRL'),
        }),
      ).toThrow();
    });

    it('should create a wallet with zero balance', () => {
      const wallet = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.zero('BRL'),
      });
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
    });
  });

  describe('debit()', () => {
    it('should debit and return ledger data', () => {
      const wallet = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });

      const result = wallet.debit(Money.from({ amount: '30.00', currency: 'BRL' }));

      expect(result.direction).toBe(LedgerDirection.Debit);
      expect(result.balanceBefore.amount).toBe('100.00');
      expect(result.balanceAfter.amount).toBe('70.00');
      expect(wallet.balance.amount).toBe('70.00');
      expect(wallet.version).toBe(2);
    });

    it('should reject debit with insufficient balance', () => {
      const wallet = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });

      expect(() =>
        wallet.debit(Money.from({ amount: '150.00', currency: 'BRL' })),
      ).toThrow(InsufficientBalanceError);
      expect(wallet.balance.amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('should reject zero debit', () => {
      const wallet = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });
      expect(() =>
        wallet.debit(Money.zero('BRL')),
      ).toThrow();
    });
  });

  describe('credit()', () => {
    it('should credit and return ledger data', () => {
      const wallet = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });

      const result = wallet.credit(Money.from({ amount: '50.00', currency: 'BRL' }));

      expect(result.direction).toBe(LedgerDirection.Credit);
      expect(result.balanceBefore.amount).toBe('100.00');
      expect(result.balanceAfter.amount).toBe('150.00');
      expect(wallet.balance.amount).toBe('150.00');
      expect(wallet.version).toBe(2);
    });

    it('should reject zero credit', () => {
      const wallet = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });
      expect(() =>
        wallet.credit(Money.zero('BRL')),
      ).toThrow();
    });
  });

  describe('currency mismatch', () => {
    it('should reject debit with different currency', () => {
      const wallet = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });
      expect(() =>
        wallet.debit(Money.from({ amount: '30.00', currency: 'USD' })),
      ).toThrow(CurrencyMismatchError);
    });

    it('should reject credit with different currency', () => {
      const wallet = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });
      expect(() =>
        wallet.credit(Money.from({ amount: '30.00', currency: 'USD' })),
      ).toThrow(CurrencyMismatchError);
    });
  });

  describe('rehydrate()', () => {
    it('should reconstruct wallet from persisted state without revalidating', () => {
      const wallet = Wallet.rehydrate({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        balanceAmount: '50.00',
        balanceCurrency: 'BRL',
        version: 5,
      });
      expect(wallet.balance.amount).toBe('50.00');
      expect(wallet.version).toBe(5);
    });

    it('should preserve persisted audit timestamps', () => {
      const createdAt = new Date('2024-01-01T10:00:00.000Z');
      const updatedAt = new Date('2024-02-01T10:00:00.000Z');
      const wallet = Wallet.rehydrate({
        id: 'w1',
        playerId: 'p1',
        currency: 'BRL',
        balanceAmount: '50.00',
        balanceCurrency: 'BRL',
        version: 5,
        createdAt,
        updatedAt,
      });
      expect(wallet.createdAt).toEqual(createdAt);
      expect(wallet.updatedAt).toEqual(updatedAt);
    });
  });
});
