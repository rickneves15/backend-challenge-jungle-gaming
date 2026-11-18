import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';

export interface WagerTransactionRepository {
  findById(id: string, em?: EntityManager<PostgreSqlDriver>): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string, em?: EntityManager<PostgreSqlDriver>): Promise<WagerTransaction | null>;
  findByProviderAndExternal(
    providerId: string,
    externalTransactionId: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<WagerTransaction | null>;
  findReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<WagerTransaction | null>;
  findPendingReferenceOlderThan(
    cutoff: Date,
    limit: number,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<WagerTransaction[]>;
  save(tx: WagerTransaction, em?: EntityManager<PostgreSqlDriver>): Promise<void>;
  lockById(id: string, em?: EntityManager<PostgreSqlDriver>): Promise<WagerTransaction | null>;
}

export type { WagerTransactionStatus };
