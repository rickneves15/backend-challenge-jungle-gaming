import { Money } from '@/shared/domain/value-objects/money';
import { LedgerDirection } from '@/shared/domain/value-objects/ledger-direction';

export interface LedgerBalanceProps {
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

/** balanceBefore ± money === balanceAfter, with a single currency throughout. */
export function isBalanced(props: LedgerBalanceProps): boolean {
  const { direction, money, balanceBefore, balanceAfter } = props;
  if (
    balanceBefore.currency !== money.currency ||
    balanceAfter.currency !== money.currency
  ) {
    return false;
  }

  const expected =
    direction === LedgerDirection.Credit
      ? balanceBefore.add(money)
      : balanceBefore.subtract(money);
  return expected.equals(balanceAfter);
}

