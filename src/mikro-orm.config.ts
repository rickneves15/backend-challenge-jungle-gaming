import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { Wallet } from './shared/infrastructure/persistence/mikro-orm/entities/wallet.entity';
import { WagerTransaction } from './shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';
import { WalletLedgerEntry } from './shared/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.entity';
import { InboxMessage } from './shared/infrastructure/persistence/mikro-orm/entities/inbox-message.entity';
import { OutboxMessage } from './shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity';

export const mikroOrmConfig: any = {
  driver: PostgreSqlDriver,
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'jungle',
  password: process.env.PGPASSWORD ?? 'jungle',
  dbName: process.env.PGDATABASE ?? 'jungle_gaming',
  // Workers/repos call EM methods outside a request-scoped context, so the
  // global EntityManager is used intentionally. Forking would also work, but
  // the repositories are registered as singletons with the global EM.
  allowGlobalContext: true,

  entities: [
    Wallet,
    WagerTransaction,
    WalletLedgerEntry,
    InboxMessage,
    OutboxMessage,
  ],

  migrations: {
    path: './src/shared/infrastructure/persistence/migrations',
    pathTs: './src/shared/infrastructure/persistence/migrations',
    transactional: true,
    disableForeignKeys: false,
    fileName: (timestamp: string, name?: string) =>
      `${timestamp}_${name ?? 'migration'}`,
  },

  discovery: {
    warnWhenNoEntities: false,
    requireEntitiesArray: false,
  },

  logger: (msg: any, context?: string) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[MikroORM] ${context ? context + ': ' : ''}${msg}`);
    }
  },
};

export default mikroOrmConfig;
