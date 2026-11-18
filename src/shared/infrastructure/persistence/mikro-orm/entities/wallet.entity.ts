import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Index,
} from '@mikro-orm/core';

import { Money } from '@/shared/domain/value-objects/money';
import { LedgerDirection } from '@/shared/domain/value-objects/ledger-direction';
import { DomainError, CurrencyMismatchError } from '@/shared/domain/errors/domain-error';
import {
  assertPositiveNonZero,
  assertSameCurrency,
  computeCredit,
  computeDebit,
} from '@/shared/domain/rules/wallet-rules';

export interface WalletBalanceSnapshot {
  amount: string;
  currency: string;
}

export interface WalletOpenProps {
  id: string;
  playerId: string;
  currency: string;
  initialBalance: Money;
}

export interface WalletDebitResult {
  direction: LedgerDirection.Debit;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export interface WalletCreditResult {
  direction: LedgerDirection.Credit;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
@Index({ properties: ['playerId'] })
export class Wallet {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'varchar', length: 255 })
  playerId!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  @Property({ type: 'text' })
  balanceAmount!: string;

  @Property({ type: 'varchar', length: 3 })
  balanceCurrency!: string;

  @Property({ type: 'number' })
  version!: number;

  @Property({ type: 'date', defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ type: 'date', onUpdate: () => new Date(), defaultRaw: 'now()' })
  updatedAt!: Date;

  constructor(
    id: string,
    playerId: string,
    currency: string,
    balanceAmount: string,
    balanceCurrency: string,
    version?: number,
    timestamps?: { createdAt?: Date; updatedAt?: Date },
  ) {
    this.id = id;
    this.playerId = playerId;
    this.currency = currency;
    this.balanceAmount = balanceAmount;
    this.balanceCurrency = balanceCurrency;
    this.version = version ?? 1;
    this.createdAt = timestamps?.createdAt ?? new Date();
    this.updatedAt = timestamps?.updatedAt ?? new Date();
  }

  get balance(): Money {
    return Money.from({ amount: this.balanceAmount, currency: this.balanceCurrency });
  }

  static open(props: WalletOpenProps): Wallet {
    const { id, playerId, initialBalance } = props;
    if (playerId.length === 0) {
      throw new DomainError('WALLET_INVALID_PLAYER_ID', 'playerId is required', 400);
    }
    if (props.currency !== initialBalance.currency) {
      throw new CurrencyMismatchError(props.currency, initialBalance.currency);
    }
    return new Wallet(id, playerId, initialBalance.currency, initialBalance.amount, initialBalance.currency, 1);
  }

  static rehydrate(state: {
    id: string;
    playerId: string;
    currency: string;
    balanceAmount: string;
    balanceCurrency: string;
    version: number;
    createdAt?: Date;
    updatedAt?: Date;
  }): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balanceAmount,
      state.balanceCurrency,
      state.version,
      { createdAt: state.createdAt, updatedAt: state.updatedAt },
    );
  }

  debit(money: Money): WalletDebitResult {
    assertSameCurrency(this.currency, money);
    assertPositiveNonZero(money, 'debit');

    const result = computeDebit(this.id, this.balance, money);
    this.balanceAmount = result.balanceAfter.amount;
    this.balanceCurrency = result.balanceAfter.currency;
    this.version += 1;
    this.updatedAt = new Date();
    return result;
  }

  credit(money: Money): WalletCreditResult {
    assertSameCurrency(this.currency, money);
    assertPositiveNonZero(money, 'credit');

    // Credit cannot make a non-negative balance negative (Money.from rejects
    // negatives); the former post-add guard was unreachable and was removed.
    const result = computeCredit(this.balance, money);
    this.balanceAmount = result.balanceAfter.amount;
    this.balanceCurrency = result.balanceAfter.currency;
    this.version += 1;
    this.updatedAt = new Date();
    return result;
  }

  toSnapshot(): WalletBalanceSnapshot {
    return { amount: this.balanceAmount, currency: this.balanceCurrency };
  }
}
