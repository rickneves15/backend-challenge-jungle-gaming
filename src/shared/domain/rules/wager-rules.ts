import { LedgerDirection, ledgerDirectionOpposite } from '@/shared/domain/value-objects/ledger-direction';

/**
 * Pure wager domain rules. This module has no persistence imports: the ORM
 * entity delegates here so the rules can be reused and tested independently.
 */
export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
}

const TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
};

const TERMINAL = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
]);

export function isTerminal(status: WagerTransactionStatus): boolean {
  return TERMINAL.has(status);
}

export function canTransition(
  from: WagerTransactionStatus,
  to: WagerTransactionStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function affectsBalance(kind: WagerTransactionKind): boolean {
  return kind !== WagerTransactionKind.Loss;
}

export function requiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

export function validReferenceKinds(kind: WagerTransactionKind): WagerTransactionKind[] {
  switch (kind) {
    case WagerTransactionKind.Refund:
      return [WagerTransactionKind.Bet];
    case WagerTransactionKind.Rollback:
      return [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
    default:
      return [];
  }
}

/** Intrinsic direction of one transaction kind, independent of its reference. */
export function directionForKind(kind: WagerTransactionKind): LedgerDirection {
  switch (kind) {
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Refund:
      return LedgerDirection.Credit;
    default:
      return LedgerDirection.Debit;
  }
}

/** ROLLBACK reverses the referenced transaction's direction. */
export function ledgerDirectionFor(
  kind: WagerTransactionKind,
  referenceKind?: WagerTransactionKind,
): LedgerDirection {
  if (kind === WagerTransactionKind.Rollback && referenceKind) {
    return ledgerDirectionOpposite(directionForKind(referenceKind));
  }
  return directionForKind(kind);
}
