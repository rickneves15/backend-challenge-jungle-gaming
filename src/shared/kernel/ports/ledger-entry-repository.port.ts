import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { WalletLedgerEntry } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.entity';

export interface LedgerEntryRepository {
  findByTransactionId(
    transactionId: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<WalletLedgerEntry | null>;
  findByWallet(
    walletId: string,
    cursor?: string,
    limit?: number,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<{
    entries: WalletLedgerEntry[];
    nextCursor?: string;
  }>;
  save(entry: WalletLedgerEntry, em?: EntityManager<PostgreSqlDriver>): Promise<void>;
}
