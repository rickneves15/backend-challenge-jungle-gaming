import type { EntityManager, IsolationLevel } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';

export interface TransactionOptions {
  /** Read consistency for the transaction (e.g. repeatable read for audits). */
  isolationLevel?: IsolationLevel;
}

/** Runs a callback in one clean SQL transaction. */
export interface UnitOfWork {
  transactional<T>(
    fn: (em: EntityManager<PostgreSqlDriver>) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}
