import Decimal from 'decimal.js-light';

import { InvalidMoneyError } from '@/shared/domain/errors/domain-error';

/**
 * Money — immutable value object for monetary amounts.
 *
 * - value stored as `Decimal` with fixed scale of 2 decimal places;
 * - input and serialization always as decimal string (contract JSON: { amount: "25.00", currency: "BRL" });
 * - never uses `number` for money;
 * - immutable: every operation returns a new instance.
 */
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export interface MoneyProps {
  amount: string;   // decimal string, e.g. "25.00"
  currency: string; // ISO-4217, e.g. "BRL"
}

export class Money {
  private static readonly SCALE = 2;
  private static readonly CURRENCY_REGEX = /^[A-Z]{3}$/;
  // accepts only integer or decimal with at most 2 places, no exponent, no negative sign
  private static readonly AMOUNT_REGEX = /^\d+(?:\.\d{1,2})?$/;

  private constructor(
    value: Decimal | string,
    public readonly currency: string,
  ) {
    this.value = typeof value === 'string' ? new Decimal(value) : value;
    Object.freeze(this);
  }

  private readonly value: Decimal;

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof amount !== 'string' || amount.length === 0) {
      throw new InvalidMoneyError('amount must be a non-empty string');
    }

    if (!Money.AMOUNT_REGEX.test(amount)) {
      throw new InvalidMoneyError(
        `invalid amount "${amount}": must be a decimal with at most 2 places, no scientific notation, no negative sign`,
      );
    }

    Money.assertValidCurrency(currency);

    const decimal = new Decimal(amount);

    return new Money(decimal, currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  static assertValidCurrency(currency: string): void {
    if (typeof currency !== 'string' || !Money.CURRENCY_REGEX.test(currency)) {
      throw new InvalidMoneyError(
        `invalid currency "${currency}": must be ISO-4217 with 3 uppercase letters (e.g. BRL)`,
      );
    }
  }

  get amount(): string {
    return this.value.toFixed(Money.SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new InvalidMoneyError(
        `incompatible currencies: ${this.currency} vs ${other.currency}`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value).toFixed(Money.SCALE), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value).toFixed(Money.SCALE), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated().toFixed(Money.SCALE), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }
}
