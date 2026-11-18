import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { mikroOrmConfig } from '@/mikro-orm.config.ts';

/**
 * Creates a MikroORM instance connected to the test database and applies the
 * migrations. Used by the integration tests.
 */
export async function setupTestDb() {
  const orm = await MikroORM.init<PostgreSqlDriver>({
    ...mikroOrmConfig,
    // Integration tests intentionally use the identity map of the global EM.
    allowGlobalContext: true,
  } as any);

  const migrator = orm.getMigrator();
  await migrator.up();

  return orm;
}

/**
 * Clears all domain tables (except migrations) between tests.
 */
export async function cleanDb(orm: MikroORM<PostgreSqlDriver>) {
  const em = orm.em;
  await em.execute(`TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE`);
  // TRUNCATE bypasses the ORM, so the global identity map must be cleared too;
  // otherwise entities from the previous test would be re-inserted on flush.
  orm.em.clear();
}

/**
 * Closes the ORM connection.
 */
export async function teardownTestDb(orm: MikroORM<PostgreSqlDriver>) {
  await orm.close(true);
}
