import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Wallet } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet.entity';

export interface WalletRepository {
  findById(id: string, em?: EntityManager<PostgreSqlDriver>): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string, em?: EntityManager<PostgreSqlDriver>): Promise<Wallet | null>;
  save(wallet: Wallet, em?: EntityManager<PostgreSqlDriver>): Promise<void>;
  lockById(id: string, em?: EntityManager<PostgreSqlDriver>): Promise<Wallet | null>;
  /** Serializes creation for one (playerId, currency) inside a transaction. */
  lockForCreation(
    playerId: string,
    currency: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<void>;
}

