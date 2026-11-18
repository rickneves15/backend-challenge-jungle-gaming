import { describe, it, expect } from 'bun:test';
import {
  InvalidMoneyError,
  WalletNotFoundError,
  WalletAlreadyExistsError,
  CurrencyMismatchError,
  InsufficientBalanceError,
  ReversalWouldOverdrawError,
  ReferenceRequiredError,
  isBusinessRejection,
  InvalidTransactionStateError,
  DuplicateReferenceReversalError,
  ReferenceNotFoundError,
  ReferenceMismatchError,
  ValueMismatchError,
  IdempotencyConflictError,
  LedgerImbalanceError,
  MessagePayloadChangedError,
  InvalidCommandMessageError,
  DomainError,
} from '@/shared/domain/errors/domain-error.ts';

describe('Domain errors', () => {
  describe('DomainError base', () => {
    it('should carry code, message and statusCode', () => {
      const err = new DomainError('TEST_CODE', 'test message', 418);
      expect(err.code).toBe('TEST_CODE');
      expect(err.message).toBe('test message');
      expect(err.statusCode).toBe(418);
      expect(err.name).toBe('DomainError');
    });
  });

  describe('InvalidMoneyError', () => {
    it('should have INVALID_MONEY code and 400 status', () => {
      const err = new InvalidMoneyError('bad amount');
      expect(err.code).toBe('INVALID_MONEY');
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe('bad amount');
    });
  });

  describe('WalletNotFoundError', () => {
    it('should have WALLET_NOT_FOUND code and 404 status', () => {
      const err = new WalletNotFoundError('w-123');
      expect(err.code).toBe('WALLET_NOT_FOUND');
      expect(err.statusCode).toBe(404);
      expect(err.message).toContain('w-123');
    });
  });

  describe('WalletAlreadyExistsError', () => {
    it('should have WALLET_ALREADY_EXISTS code and 409 status', () => {
      const err = new WalletAlreadyExistsError('p-1', 'BRL');
      expect(err.code).toBe('WALLET_ALREADY_EXISTS');
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain('p-1');
      expect(err.message).toContain('BRL');
    });
  });

  describe('CurrencyMismatchError', () => {
    it('should have CURRENCY_MISMATCH code and 422 status', () => {
      const err = new CurrencyMismatchError('BRL', 'USD');
      expect(err.code).toBe('CURRENCY_MISMATCH');
      expect(err.statusCode).toBe(422);
      expect(err.message).toContain('BRL');
      expect(err.message).toContain('USD');
    });
  });

  describe('InsufficientBalanceError', () => {
    it('should have INSUFFICIENT_BALANCE code and 422 status', () => {
      const err = new InsufficientBalanceError('w-1', '100.00', '150.00');
      expect(err.code).toBe('INSUFFICIENT_BALANCE');
      expect(err.statusCode).toBe(422);
      expect(err.message).toContain('100.00');
      expect(err.message).toContain('150.00');
    });
  });

  describe('ReversalWouldOverdrawError', () => {
    it('should have REVERSAL_WOULD_OVERDRAW code and 422 status', () => {
      const err = new ReversalWouldOverdrawError('w-1', '10.00', '25.00');
      expect(err.code).toBe('REVERSAL_WOULD_OVERDRAW');
      expect(err.statusCode).toBe(422);
      expect(isBusinessRejection(err)).toBe(true);
    });
  });

  describe('ReferenceRequiredError', () => {
    it('should have REFERENCE_REQUIRED code and 422 status', () => {
      const err = new ReferenceRequiredError('REFUND');
      expect(err.code).toBe('REFERENCE_REQUIRED');
      expect(err.statusCode).toBe(422);
      expect(err.message).toContain('REFUND');
      expect(isBusinessRejection(err)).toBe(true);
    });
  });

  describe('isBusinessRejection()', () => {
    it('should not classify idempotency conflicts as business rejections', () => {
      expect(isBusinessRejection(new IdempotencyConflictError('key-1'))).toBe(false);
      expect(isBusinessRejection(new Error('boom'))).toBe(false);
    });
  });

  describe('InvalidTransactionStateError', () => {
    it('should have INVALID_TRANSACTION_STATE code and 409 status', () => {
      const err = new InvalidTransactionStateError('t-1', 'PENDING', 'PROCESSED');
      expect(err.code).toBe('INVALID_TRANSACTION_STATE');
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain('t-1');
    });
  });

  describe('DuplicateReferenceReversalError', () => {
    it('should have DUPLICATE_REFERENCE_REVERSAL code and 422 status', () => {
      const err = new DuplicateReferenceReversalError('ext-1', 'REFUND');
      expect(err.code).toBe('DUPLICATE_REFERENCE_REVERSAL');
      expect(err.statusCode).toBe(422);
      expect(err.message).toContain('ext-1');
      expect(err.message).toContain('REFUND');
    });
  });

  describe('ReferenceNotFoundError', () => {
    it('should have REFERENCE_NOT_FOUND code and 404 status', () => {
      const err = new ReferenceNotFoundError('prov-1', 'ext-1');
      expect(err.code).toBe('REFERENCE_NOT_FOUND');
      expect(err.statusCode).toBe(404);
      expect(err.message).toContain('prov-1');
      expect(err.message).toContain('ext-1');
    });
  });

  describe('ReferenceMismatchError', () => {
    it('should have REFERENCE_MISMATCH code and 422 status', () => {
      const err = new ReferenceMismatchError('ext-1');
      expect(err.code).toBe('REFERENCE_MISMATCH');
      expect(err.statusCode).toBe(422);
      expect(err.message).toContain('ext-1');
    });
  });

  describe('ValueMismatchError', () => {
    it('should have VALUE_MISMATCH code and 422 status', () => {
      const err = new ValueMismatchError('money', '25.00', '30.00');
      expect(err.code).toBe('VALUE_MISMATCH');
      expect(err.statusCode).toBe(422);
      expect(err.message).toContain('25.00');
      expect(err.message).toContain('30.00');
    });
  });

  describe('IdempotencyConflictError', () => {
    it('should have IDEMPOTENCY_CONFLICT code and 409 status', () => {
      const err = new IdempotencyConflictError('key-1');
      expect(err.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain('key-1');
    });
  });

  describe('LedgerImbalanceError', () => {
    it('should carry transaction context and a 500 status', () => {
      const err = new LedgerImbalanceError('tx-1');
      expect(err.code).toBe('LEDGER_IMBALANCE');
      expect(err.statusCode).toBe(500);
      expect(err.message).toContain('tx-1');
      expect(isBusinessRejection(err)).toBe(false);
    });
  });

  describe('MessagePayloadChangedError', () => {
    it('should classify a mutated redelivery as a permanent conflict', () => {
      const err = new MessagePayloadChangedError('msg-1');
      expect(err.code).toBe('MESSAGE_PAYLOAD_CHANGED');
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain('msg-1');
      expect(isBusinessRejection(err)).toBe(false);
    });
  });

  describe('InvalidCommandMessageError', () => {
    it('should name the missing field and be permanent', () => {
      const err = new InvalidCommandMessageError('msg-1', 'walletId');
      expect(err.code).toBe('INVALID_COMMAND_MESSAGE');
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('walletId');
      expect(isBusinessRejection(err)).toBe(false);
    });
  });
});
