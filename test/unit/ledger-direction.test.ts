import { describe, it, expect } from 'bun:test';
import {
  LedgerDirection,
  ledgerDirectionOpposite,
} from '@/shared/domain/value-objects/ledger-direction.ts';

describe('LedgerDirection', () => {
  describe('opposite()', () => {
    it('should return CREDIT for DEBIT', () => {
      expect(ledgerDirectionOpposite(LedgerDirection.Debit)).toBe(
        LedgerDirection.Credit,
      );
    });

    it('should return DEBIT for CREDIT', () => {
      expect(ledgerDirectionOpposite(LedgerDirection.Credit)).toBe(
        LedgerDirection.Debit,
      );
    });
  });

  describe('enum values', () => {
    it('should have DEBIT = DEBIT', () => {
      expect(LedgerDirection.Debit as string).toBe('DEBIT');
    });

    it('should have Credit = CREDIT', () => {
      expect(LedgerDirection.Credit as string).toBe('CREDIT');
    });
  });
});
