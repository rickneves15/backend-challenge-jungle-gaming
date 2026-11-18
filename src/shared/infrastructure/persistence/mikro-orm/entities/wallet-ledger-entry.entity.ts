import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Index,
} from '@mikro-orm/core';

import { Money } from '@/shared/domain/value-objects/money';
import { LedgerDirection } from '@/shared/domain/value-objects/ledger-direction';
import { LedgerImbalanceError } from '@/shared/domain/errors/domain-error';
import { isBalanced as isLedgerBalanced } from '@/shared/domain/rules/ledger-rules';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  moneyAmount: string;
  moneyCurrency: string;
  balanceBeforeAmount: string;
  balanceBeforeCurrency: string;
  balanceAfterAmount: string;
  balanceAfterCurrency: string;
  createdAt: Date;
}

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['transactionId'] })
@Index({ properties: ['walletId'] })
@Index({ properties: ['transactionId'] })
export class WalletLedgerEntry {
  @PrimaryKey({ type: 'uuid' })
  id: string;

  @Property({ type: 'uuid' })
  walletId: string;

  @Property({ type: 'uuid' })
  transactionId: string;

  @Property({ type: 'varchar', length: 6 })
  direction: LedgerDirection;

  @Property({ type: 'text' })
  moneyAmount: string;

  @Property({ type: 'varchar', length: 3 })
  moneyCurrency: string;

  @Property({ type: 'text' })
  balanceBeforeAmount: string;

  @Property({ type: 'varchar', length: 3 })
  balanceBeforeCurrency: string;

  @Property({ type: 'text' })
  balanceAfterAmount: string;

  @Property({ type: 'varchar', length: 3 })
  balanceAfterCurrency: string;

  @Property({ type: 'date', defaultRaw: 'now()' })
  createdAt: Date;

  constructor(props: CreateLedgerEntryProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.direction = props.direction;
    this.moneyAmount = props.money.amount;
    this.moneyCurrency = props.money.currency;
    this.balanceBeforeAmount = props.balanceBefore.amount;
    this.balanceBeforeCurrency = props.balanceBefore.currency;
    this.balanceAfterAmount = props.balanceAfter.amount;
    this.balanceAfterCurrency = props.balanceAfter.currency;
    this.createdAt = props.createdAt ?? new Date();
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new LedgerImbalanceError(props.transactionId);
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry({
      id: state.id,
      walletId: state.walletId,
      transactionId: state.transactionId,
      direction: state.direction,
      money: { amount: state.moneyAmount, currency: state.moneyCurrency },
      balanceBefore: {
        amount: state.balanceBeforeAmount,
        currency: state.balanceBeforeCurrency,
      },
      balanceAfter: {
        amount: state.balanceAfterAmount,
        currency: state.balanceAfterCurrency,
      },
      createdAt: state.createdAt,
    });
  }

  get money(): Money {
    return Money.from({ amount: this.moneyAmount, currency: this.moneyCurrency });
  }

  get balanceBefore(): Money {
    return Money.from({
      amount: this.balanceBeforeAmount,
      currency: this.balanceBeforeCurrency,
    });
  }

  get balanceAfter(): Money {
    return Money.from({
      amount: this.balanceAfterAmount,
      currency: this.balanceAfterCurrency,
    });
  }

  /** balanceBefore ± money === balanceAfter (pure rule in the domain layer). */
  isBalanced(): boolean {
    return isLedgerBalanced({
      direction: this.direction,
      money: this.money,
      balanceBefore: this.balanceBefore,
      balanceAfter: this.balanceAfter,
    });
  }

  toJSON() {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      money: this.money.toJSON(),
      balanceBefore: this.balanceBefore.toJSON(),
      balanceAfter: this.balanceAfter.toJSON(),
      createdAt: this.createdAt,
    };
  }
}
