export class DomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Business rejections are terminal and auditable: they must be persisted as a
 * REJECTED transaction with a failureCode and an integration event. Conflict
 * errors (idempotency, duplicate wallet) are deliberately NOT in this set —
 * they describe the request, not a business decision about a transaction.
 */
export const BUSINESS_REJECTION_CODES = new Set([
  'INSUFFICIENT_BALANCE',
  'REVERSAL_WOULD_OVERDRAW',
  'CURRENCY_MISMATCH',
  'REFERENCE_REQUIRED',
  'REFERENCE_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'VALUE_MISMATCH',
  'DUPLICATE_REFERENCE_REVERSAL',
]);

export function isBusinessRejection(error: unknown): error is DomainError {
  return error instanceof DomainError && BUSINESS_REJECTION_CODES.has(error.code);
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message, 400);
  }
}

export class InvalidCurrencyError extends DomainError {
  constructor(currency: string) {
    super('INVALID_CURRENCY', `unsupported currency: ${currency}`, 400);
  }
}

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', `wallet not found: ${walletId}`, 404);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(
      'WALLET_ALREADY_EXISTS',
      `wallet already exists for playerId=${playerId} and currency=${currency}`,
      409,
    );
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(walletCurrency: string, operationCurrency: string) {
    super(
      'CURRENCY_MISMATCH',
      `operation currency (${operationCurrency}) differs from wallet currency (${walletCurrency})`,
      422,
    );
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor(walletId: string, balance: string, requested: string) {
    super(
      'INSUFFICIENT_BALANCE',
      `insufficient balance on wallet ${walletId}: available ${balance}, requested ${requested}`,
      422,
    );
  }
}

/**
 * A REFUND/ROLLBACK that would overdraw the wallet is operationally different
 * from a plain bet with insufficient funds: providers treat them differently.
 */
export class ReversalWouldOverdrawError extends DomainError {
  constructor(walletId: string, balance: string, requested: string) {
    super(
      'REVERSAL_WOULD_OVERDRAW',
      `reversal would make wallet ${walletId} negative: available ${balance}, requested ${requested}`,
      422,
    );
  }
}

export class ReferenceRequiredError extends DomainError {
  constructor(kind: string) {
    super('REFERENCE_REQUIRED', `${kind} requires referenceExternalTransactionId`, 422);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(transactionId: string, from: string, to: string) {
    super(
      'INVALID_TRANSACTION_STATE',
      `transaction ${transactionId} cannot transition from ${from} to ${to}`,
      409,
    );
  }
}

export class DuplicateReferenceReversalError extends DomainError {
  constructor(referenceExternalTransactionId: string, kind: string) {
    super(
      'DUPLICATE_REFERENCE_REVERSAL',
      `reference ${referenceExternalTransactionId} was already reversed by ${kind}`,
      422,
    );
  }
}

export class ReferenceNotFoundError extends DomainError {
  constructor(providerId: string, referenceExternalTransactionId: string) {
    super(
      'REFERENCE_NOT_FOUND',
      `reference not found for providerId=${providerId} and externalTransactionId=${referenceExternalTransactionId}`,
      404,
    );
  }
}

export class ReferenceMismatchError extends DomainError {
  constructor(referenceExternalTransactionId: string) {
    super(
      'REFERENCE_MISMATCH',
      `reference ${referenceExternalTransactionId} does not belong to the same provider, player, wallet, currency, and round`,
      422,
    );
  }
}

export class ValueMismatchError extends DomainError {
  constructor(field: string, expected: string, actual: string) {
    super(
      'VALUE_MISMATCH',
      `${field} must match the reference: expected ${expected}, received ${actual}`,
      422,
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      'IDEMPOTENCY_CONFLICT',
      `idempotency key already used with a different payload: ${idempotencyKey}`,
      409,
    );
  }
}

/** Invariant breach: the ledger would no longer balance. Not a business rejection. */
export class LedgerImbalanceError extends DomainError {
  constructor(transactionId: string) {
    super('LEDGER_IMBALANCE', `unbalanced ledger entry for transaction ${transactionId}`, 500);
  }
}

/** An envelope id was reused with different bytes — never acknowledge it silently. */
export class MessagePayloadChangedError extends DomainError {
  constructor(messageId: string) {
    super(
      'MESSAGE_PAYLOAD_CHANGED',
      `message ${messageId} was redelivered with a different payload`,
      409,
    );
  }
}

/** A declared wager command is missing the fields required to build its input. */
export class InvalidCommandMessageError extends DomainError {
  constructor(messageId: string, field: string) {
    super(
      'INVALID_COMMAND_MESSAGE',
      `command ${messageId} is missing required field ${field}`,
      400,
    );
  }
}

