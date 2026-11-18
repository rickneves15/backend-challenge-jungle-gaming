export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function ledgerDirectionOpposite(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}
