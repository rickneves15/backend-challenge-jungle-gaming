import {
  Entity,
  PrimaryKey,
  Property,
  Enum,
  Unique,
  Index,
} from '@mikro-orm/core';

import { Money } from '@/shared/domain/value-objects/money';
import { InvalidTransactionStateError, ReferenceRequiredError } from '@/shared/domain/errors/domain-error';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  affectsBalance,
  canTransition,
  isTerminal,
  ledgerDirectionFor as ledgerDirectionForRule,
  requiresReference,
  validReferenceKinds,
} from '@/shared/domain/rules/wager-rules';

// Re-exported so existing callers can keep importing the enums from the entity.
export { WagerTransactionKind, WagerTransactionStatus };

export type FailureCode = string;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  moneyAmount: string;
  moneyCurrency: string;
  referenceExternalTransactionId?: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  failureReason?: string;
  processedAt?: Date;
  createdAt: Date;
  version: number;
  referenceAttempts?: number;
  nextAttemptAt?: Date;
  balanceSnapshotAmount?: string;
  balanceSnapshotCurrency?: string;
}

export {
  affectsBalance,
  isTerminal,
  requiresReference,
  validReferenceKinds,
} from '@/shared/domain/rules/wager-rules';

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['idempotencyKey'] })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
@Index({ properties: ['walletId'] })
@Index({ properties: ['status'] })
@Index({ properties: ['roundId'] })
export class WagerTransaction {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'varchar', length: 255 })
  providerId!: string;

  @Property({ type: 'varchar', length: 255 })
  externalTransactionId!: string;

  @Property({ type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Property({ type: 'varchar', length: 64 })
  payloadHash!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'varchar', length: 255 })
  playerId!: string;

  @Property({ type: 'varchar', length: 255 })
  roundId!: string;

  @Property({ type: 'varchar', length: 255 })
  gameId!: string;

  @Enum(() => WagerTransactionKind)
  kind!: WagerTransactionKind;

  @Property({ type: 'text' })
  moneyAmount!: string;

  @Property({ type: 'varchar', length: 3 })
  moneyCurrency!: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: 'varchar', length: 30 })
  status!: WagerTransactionStatus;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ type: 'varchar', length: 64, nullable: true })
  failureCode?: FailureCode;

  /** Original rejection message, replayed verbatim on idempotent retries. */
  @Property({ type: 'text', nullable: true })
  failureReason?: string;

  @Property({ type: 'date', nullable: true })
  processedAt?: Date;

  @Property({ type: 'number' })
  version!: number;

  @Property({ type: 'date', defaultRaw: 'now()' })
  createdAt!: Date;

  /** Retries already made while waiting for a referenced transaction. */
  @Property({ type: 'number', default: 0 })
  referenceAttempts!: number;

  /** Next time the pending-reference worker may try this transaction. */
  @Property({ type: 'date', nullable: true })
  nextAttemptAt?: Date;

  /**
   * Balance observed when the transaction was processed. Required by rule 7.7:
   * an idempotent replay must return the ORIGINAL result, not today's balance.
   */
  @Property({ type: 'text', nullable: true })
  balanceSnapshotAmount?: string;

  @Property({ type: 'varchar', length: 3, nullable: true })
  balanceSnapshotCurrency?: string;

  constructor(props: CreateWagerTransactionProps) {
    this.id = props.id;
    this.providerId = props.providerId;
    this.externalTransactionId = props.externalTransactionId;
    this.idempotencyKey = props.idempotencyKey;
    this.payloadHash = props.payloadHash;
    this.walletId = props.walletId;
    this.playerId = props.playerId;
    this.roundId = props.roundId;
    this.gameId = props.gameId;
    this.kind = props.kind;
    this.moneyAmount = props.money.amount;
    this.moneyCurrency = props.money.currency;
    this.referenceExternalTransactionId = props.referenceExternalTransactionId;
    this.status = WagerTransactionStatus.Pending;
    this.createdAt = new Date();
    this.version = 1;
    this.referenceAttempts = 0;
    this.nextAttemptAt = undefined;
    this.balanceSnapshotAmount = undefined;
    this.balanceSnapshotCurrency = undefined;
    this.failureReason = undefined;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (requiresReference(props.kind) && !props.referenceExternalTransactionId) {
      throw new ReferenceRequiredError(props.kind);
    }
    return new WagerTransaction(props);
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    const tx = new WagerTransaction({
      id: state.id,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      idempotencyKey: state.idempotencyKey,
      payloadHash: state.payloadHash,
      walletId: state.walletId,
      playerId: state.playerId,
      roundId: state.roundId,
      gameId: state.gameId,
      kind: state.kind,
      money: { amount: state.moneyAmount, currency: state.moneyCurrency },
      referenceExternalTransactionId: state.referenceExternalTransactionId,
    });
    tx.status = state.status;
    tx.referenceTransactionId = state.referenceTransactionId;
    tx.failureCode = state.failureCode;
    tx.failureReason = state.failureReason;
    tx.processedAt = state.processedAt;
    tx.version = state.version;
    tx.referenceAttempts = state.referenceAttempts ?? 0;
    tx.nextAttemptAt = state.nextAttemptAt;
    tx.balanceSnapshotAmount = state.balanceSnapshotAmount;
    tx.balanceSnapshotCurrency = state.balanceSnapshotCurrency;
    return tx;
  }

  get money(): Money {
    return Money.from({ amount: this.moneyAmount, currency: this.moneyCurrency });
  }

  get isTerminal(): boolean {
    return isTerminal(this.status);
  }

  get affectsBalance(): boolean {
    return affectsBalance(this.kind);
  }

  get requiresReference(): boolean {
    return requiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  get balanceSnapshot(): { amount: string; currency: string } | undefined {
    if (!this.balanceSnapshotAmount || !this.balanceSnapshotCurrency) return undefined;
    return { amount: this.balanceSnapshotAmount, currency: this.balanceSnapshotCurrency };
  }

  setBalanceSnapshot(snapshot: { amount: string; currency: string }): void {
    this.balanceSnapshotAmount = snapshot.amount;
    this.balanceSnapshotCurrency = snapshot.currency;
  }

  /** Increments the retry counter and schedules the next attempt. */
  recordReferenceAttempt(at: Date, nextAttemptAt: Date): void {
    this.referenceAttempts += 1;
    this.nextAttemptAt = nextAttemptAt;
    this.version += 1;
  }

  ledgerDirectionFor(reference?: WagerTransaction) {
    return ledgerDirectionForRule(this.kind, reference?.kind);
  }

  private assertCanTransitionTo(next: WagerTransactionStatus): void {
    if (!canTransition(this.status, next)) {
      throw new InvalidTransactionStateError(this.id, this.status, next);
    }
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Processed);
    this.status = WagerTransactionStatus.Processed;
    this.referenceTransactionId = referenceTransactionId;
    this.processedAt = at;
    this.version += 1;
  }

  markPendingReference(): void {
    this.assertCanTransitionTo(WagerTransactionStatus.PendingReference);
    this.status = WagerTransactionStatus.PendingReference;
    this.version += 1;
  }

  reject(code: FailureCode, at: Date = new Date(), reason?: string): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Rejected);
    this.status = WagerTransactionStatus.Rejected;
    this.failureCode = code;
    this.failureReason = reason;
    this.processedAt = at;
    this.nextAttemptAt = undefined;
    this.version += 1;
  }
}
