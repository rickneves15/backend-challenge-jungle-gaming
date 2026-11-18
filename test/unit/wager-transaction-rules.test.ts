import { describe, it, expect } from 'bun:test';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';
import { LedgerDirection } from '@/shared/domain/value-objects/ledger-direction';
import { DomainError, ReferenceRequiredError } from '@/shared/domain/errors/domain-error';

function makeTransaction(
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: `tx-${kind}`,
    providerId: 'provider-1',
    externalTransactionId: `ext-${kind}`,
    idempotencyKey: `provider-1:ext-${kind}`,
    payloadHash: 'hash-original',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount: '25.00', currency: 'BRL' },
    referenceExternalTransactionId:
      referenceExternalTransactionId ??
      (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
        ? 'ext-reference'
        : undefined),
  });
}

describe('WagerTransaction entity rules', () => {
  describe('ledgerDirectionFor()', () => {
    it('should debit BET and LOSS', () => {
      expect(makeTransaction(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(
        LedgerDirection.Debit,
      );
      expect(makeTransaction(WagerTransactionKind.Loss).ledgerDirectionFor()).toBe(
        LedgerDirection.Debit,
      );
    });

    it('should credit WIN and REFUND', () => {
      expect(makeTransaction(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(
        LedgerDirection.Credit,
      );
      expect(makeTransaction(WagerTransactionKind.Refund).ledgerDirectionFor()).toBe(
        LedgerDirection.Credit,
      );
    });

    it('should default ROLLBACK to debit when no reference is available', () => {
      expect(
        makeTransaction(WagerTransactionKind.Rollback).ledgerDirectionFor(),
      ).toBe(LedgerDirection.Debit);
    });

    it('should invert a referenced BET direction on ROLLBACK (credit)', () => {
      const bet = makeTransaction(WagerTransactionKind.Bet);
      const rollback = makeTransaction(WagerTransactionKind.Rollback);
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    });

    it('should invert a referenced WIN direction on ROLLBACK (debit)', () => {
      const win = makeTransaction(WagerTransactionKind.Win);
      const rollback = makeTransaction(WagerTransactionKind.Rollback);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    });
  });

  describe('state transitions', () => {
    it('should start in PENDING with version 1', () => {
      const tx = makeTransaction(WagerTransactionKind.Bet);
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.version).toBe(1);
      expect(tx.isTerminal).toBe(false);
    });

    it('should move from PENDING to PENDING_REFERENCE to PROCESSED', () => {
      const tx = makeTransaction(WagerTransactionKind.Refund);
      tx.markPendingReference();
      expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
      tx.markProcessed('reference-1', new Date());
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.referenceTransactionId).toBe('reference-1');
      expect(tx.processedAt).toBeInstanceOf(Date);
    });

    it('should move from PENDING to REJECTED with a failure code', () => {
      const tx = makeTransaction(WagerTransactionKind.Bet);
      tx.reject('INSUFFICIENT_BALANCE');
      expect(tx.status).toBe(WagerTransactionStatus.Rejected);
      expect(tx.failureCode).toBe('INSUFFICIENT_BALANCE');
      expect(tx.isTerminal).toBe(true);
    });

    it('should reject any transition out of a terminal state', () => {
      const processed = makeTransaction(WagerTransactionKind.Bet);
      processed.markProcessed(undefined, new Date());
      expect(() => processed.markProcessed(undefined, new Date())).toThrow(DomainError);
      expect(() => processed.markPendingReference()).toThrow(DomainError);
      expect(() => processed.reject('X')).toThrow(DomainError);
    });

    it('should reject repeating PENDING_REFERENCE from PENDING_REFERENCE', () => {
      const tx = makeTransaction(WagerTransactionKind.Refund);
      tx.markPendingReference();
      expect(() => tx.markPendingReference()).toThrow(DomainError);
    });

    it('should increment version on every transition', () => {
      const tx = makeTransaction(WagerTransactionKind.Refund);
      tx.markPendingReference();
      expect(tx.version).toBe(2);
      tx.markProcessed('reference-1', new Date());
      expect(tx.version).toBe(3);
    });
  });

  describe('create()', () => {
    it('should require a reference for REFUND and ROLLBACK', () => {
      expect(() =>
        WagerTransaction.create({
          id: 'tx-no-ref',
          providerId: 'provider-1',
          externalTransactionId: 'ext-no-ref',
          idempotencyKey: 'provider-1:ext-no-ref',
          payloadHash: 'hash-original',
          walletId: 'wallet-1',
          playerId: 'player-1',
          roundId: 'round-1',
          gameId: 'game-1',
          kind: WagerTransactionKind.Refund,
          money: { amount: '25.00', currency: 'BRL' },
        }),
      ).toThrow(ReferenceRequiredError);
    });
  });

  describe('matchesPayload()', () => {
    it('should accept the same payload hash', () => {
      const tx = makeTransaction(WagerTransactionKind.Bet);
      expect(tx.matchesPayload('hash-original')).toBe(true);
    });

    it('should reject a diverging payload hash (idempotency conflict)', () => {
      const tx = makeTransaction(WagerTransactionKind.Bet);
      expect(tx.matchesPayload('hash-different')).toBe(false);
    });
  });
});
