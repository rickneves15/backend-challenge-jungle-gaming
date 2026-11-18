import { describe, it, expect } from 'bun:test';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  affectsBalance,
  requiresReference,
  validReferenceKinds,
  isTerminal,
} from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';

describe('WagerTransaction domain functions', () => {
  describe('affectsBalance()', () => {
    it('should return true for BET', () => {
      expect(affectsBalance(WagerTransactionKind.Bet)).toBe(true);
    });
    it('should return true for WIN', () => {
      expect(affectsBalance(WagerTransactionKind.Win)).toBe(true);
    });
    it('should return true for REFUND', () => {
      expect(affectsBalance(WagerTransactionKind.Refund)).toBe(true);
    });
    it('should return true for ROLLBACK', () => {
      expect(affectsBalance(WagerTransactionKind.Rollback)).toBe(true);
    });
    it('should return false for LOSS', () => {
      expect(affectsBalance(WagerTransactionKind.Loss)).toBe(false);
    });
    it('should return true for OPENING', () => {
      expect(affectsBalance(WagerTransactionKind.Opening)).toBe(true);
    });
  });

  describe('requiresReference()', () => {
    it('should return true for REFUND', () => {
      expect(requiresReference(WagerTransactionKind.Refund)).toBe(true);
    });
    it('should return true for ROLLBACK', () => {
      expect(requiresReference(WagerTransactionKind.Rollback)).toBe(true);
    });
    it('should return false for BET', () => {
      expect(requiresReference(WagerTransactionKind.Bet)).toBe(false);
    });
    it('should return false for WIN', () => {
      expect(requiresReference(WagerTransactionKind.Win)).toBe(false);
    });
    it('should return false for LOSS', () => {
      expect(requiresReference(WagerTransactionKind.Loss)).toBe(false);
    });
  });

  describe('validReferenceKinds()', () => {
    it('should allow only BET for REFUND', () => {
      expect(validReferenceKinds(WagerTransactionKind.Refund)).toEqual([
        WagerTransactionKind.Bet,
      ]);
    });
    it('should allow BET, WIN, REFUND for ROLLBACK', () => {
      expect(validReferenceKinds(WagerTransactionKind.Rollback)).toEqual([
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ]);
    });
    it('should return empty for BET', () => {
      expect(validReferenceKinds(WagerTransactionKind.Bet)).toEqual([]);
    });
  });

  describe('isTerminal()', () => {
    it('should return true for PROCESSED', () => {
      expect(isTerminal(WagerTransactionStatus.Processed)).toBe(true);
    });
    it('should return true for REJECTED', () => {
      expect(isTerminal(WagerTransactionStatus.Rejected)).toBe(true);
    });
    it('should return false for PENDING', () => {
      expect(isTerminal(WagerTransactionStatus.Pending)).toBe(false);
    });
    it('should return false for PENDING_REFERENCE', () => {
      expect(isTerminal(WagerTransactionStatus.PendingReference)).toBe(false);
    });
  });
});
