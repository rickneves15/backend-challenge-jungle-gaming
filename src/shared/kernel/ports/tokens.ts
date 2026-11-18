/**
 * Dependency-injection tokens for ports.
 *
 * Application services depend on the port interfaces, never on the concrete
 * MikroORM adapters. Symbols keep the token names from colliding with Nest's
 * class-based providers and make the adapter boundary explicit.
 */
export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const WALLET_REPOSITORY = Symbol('WalletRepository');
export const WAGER_TRANSACTION_REPOSITORY = Symbol('WagerTransactionRepository');
export const LEDGER_ENTRY_REPOSITORY = Symbol('LedgerEntryRepository');
export const INBOX_REPOSITORY = Symbol('InboxRepository');
export const OUTBOX_REPOSITORY = Symbol('OutboxRepository');
export const METRICS_SNAPSHOT_REPOSITORY = Symbol('MetricsSnapshotRepository');

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
export const LOGGER = Symbol('Logger');
