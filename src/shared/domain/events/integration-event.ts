import { LedgerDirection } from '../value-objects/ledger-direction';
import { MoneyProps } from '../value-objects/money';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data as Readonly<T>;
    Object.freeze(this);
  }

  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
  } {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

/* ------------------------------------------------------------------ */
/* WalletBalanceChanged                                               */
/* ------------------------------------------------------------------ */

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  // Defined as prototype getters (not instance fields) so the base
  // constructor can safely Object.freeze(this) before they are read.
  get eventType(): string {
    return 'WalletBalanceChanged';
  }
  get version(): number {
    return 1;
  }

  static from(
    walletId: string,
    transactionId: string,
    entry: {
      direction: LedgerDirection;
      money: { amount: string; currency: string };
      balanceBefore: { amount: string; currency: string };
      balanceAfter: { amount: string; currency: string };
    },
    walletVersion: number,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: crypto.randomUUID(),
      aggregateId: walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId,
        transactionId,
        direction: entry.direction,
        money: entry.money,
        balanceBefore: entry.balanceBefore,
        balanceAfter: entry.balanceAfter,
        walletVersion,
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* WagerTransactionProcessed                                          */
/* ------------------------------------------------------------------ */

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  idempotentReplay: boolean;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  get eventType(): string {
    return 'WagerTransactionProcessed';
  }
  get version(): number {
    return 1;
  }

  static from(props: {
    transactionId: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    kind: string;
    money: MoneyProps;
    idempotentReplay: boolean;
    ctx: EventContext;
  }): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: crypto.randomUUID(),
      aggregateId: props.transactionId,
      correlationId: props.ctx.correlationId,
      causationId: props.ctx.causationId,
      occurredAt: props.ctx.occurredAt,
      data: {
        transactionId: props.transactionId,
        walletId: props.walletId,
        playerId: props.playerId,
        providerId: props.providerId,
        externalTransactionId: props.externalTransactionId,
        kind: props.kind,
        money: props.money,
        status: 'PROCESSED',
        idempotentReplay: props.idempotentReplay,
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* WagerTransactionRejected                                           */
/* ------------------------------------------------------------------ */

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
  failureCode: string;
  reason: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  get eventType(): string {
    return 'WagerTransactionRejected';
  }
  get version(): number {
    return 1;
  }

  static from(props: {
    transactionId: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    kind: string;
    money: MoneyProps;
    failureCode: string;
    reason: string;
    ctx: EventContext;
  }): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: crypto.randomUUID(),
      aggregateId: props.transactionId,
      correlationId: props.ctx.correlationId,
      causationId: props.ctx.causationId,
      occurredAt: props.ctx.occurredAt,
      data: {
        transactionId: props.transactionId,
        walletId: props.walletId,
        playerId: props.playerId,
        providerId: props.providerId,
        externalTransactionId: props.externalTransactionId,
        kind: props.kind,
        money: props.money,
        failureCode: props.failureCode,
        reason: props.reason,
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* WagerTransactionPendingReference                                   */
/* ------------------------------------------------------------------ */

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  get eventType(): string {
    return 'WagerTransactionPendingReference';
  }
  get version(): number {
    return 1;
  }

  static from(props: {
    transactionId: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    kind: string;
    referenceExternalTransactionId: string;
    ctx: EventContext;
  }): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: crypto.randomUUID(),
      aggregateId: props.transactionId,
      correlationId: props.ctx.correlationId,
      causationId: props.ctx.causationId,
      occurredAt: props.ctx.occurredAt,
      data: {
        transactionId: props.transactionId,
        walletId: props.walletId,
        playerId: props.playerId,
        providerId: props.providerId,
        externalTransactionId: props.externalTransactionId,
        kind: props.kind,
        referenceExternalTransactionId: props.referenceExternalTransactionId,
      },
    });
  }
}
