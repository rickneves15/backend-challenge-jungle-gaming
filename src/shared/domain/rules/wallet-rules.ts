import { Money } from '@/shared/domain/value-objects/money';
import { LedgerDirection } from '@/shared/domain/value-objects/ledger-direction';
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientBalanceError,
  InvalidMoneyError,
} from '@/shared/domain/errors/domain-error';

export interface WalletMutationResult {
  direction: LedgerDirection.Debit | LedgerDirection.Credit;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export interface WalletDebitResult extends WalletMutationResult {
  direction: LedgerDirection.Debit;
}

export interface WalletCreditResult extends WalletMutationResult {
  direction: LedgerDirection.Credit;
}

/** Pure balance-transition rules shared by the persistence entity and tests. */
export function assertSameCurrency(walletCurrency: string, money: Money): void {
  if (walletCurrency !== money.currency) {
    throw new CurrencyMismatchError(walletCurrency, money.currency);
  }
}

export function assertPositiveNonZero(money: Money, operation: 'debit' | 'credit'): void {
  if (money.isZero()) {
    throw new DomainError(
      `WALLET_${operation.toUpperCase()}_ZERO`,
      `${operation} with zero amount is not allowed`,
      400,
    );
  }
  // Money.from() rejects negatives; this guard protects callers that construct
  // a Money through a non-validating path.
  if (money.isNegative()) {
    throw new InvalidMoneyError(`${operation} amount must be positive`);
  }
}

export function computeDebit(
  walletId: string,
  balance: Money,
  money: Money,
): WalletDebitResult {
  const balanceAfter = balance.subtract(money);
  if (balanceAfter.isNegative()) {
    throw new InsufficientBalanceError(walletId, balance.amount, money.amount);
  }
  return { direction: LedgerDirection.Debit, money, balanceBefore: balance, balanceAfter };
}

export function computeCredit(balance: Money, money: Money): WalletCreditResult {
  return {
    direction: LedgerDirection.Credit,
    money,
    balanceBefore: balance,
    balanceAfter: balance.add(money),
  };
}
