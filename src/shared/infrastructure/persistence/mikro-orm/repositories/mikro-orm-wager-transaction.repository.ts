import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';
import type { WagerTransactionRepository } from '@/shared/kernel/ports/wager-transaction-repository.port';

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager<PostgreSqlDriver>) {}

  async findById(id: string, em?: EntityManager<PostgreSqlDriver>): Promise<WagerTransaction | null> {
    return (em ?? this.em).findOne(WagerTransaction, { id });
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<WagerTransaction | null> {
    return (em ?? this.em).findOne(WagerTransaction, { idempotencyKey });
  }

  async findByProviderAndExternal(
    providerId: string,
    externalTransactionId: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<WagerTransaction | null> {
    return (em ?? this.em).findOne(WagerTransaction, {
      providerId,
      externalTransactionId,
    } as any);
  }

  async findReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<WagerTransaction | null> {
    return (em ?? this.em).findOne(WagerTransaction, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    } as any);
  }

  /**
   * Rows whose exponential-backoff deadline has been reached. The second
   * branch covers rows written before the retry columns existed (or whose
   * deadline was never set): they become eligible after the legacy grace
   * period so an upgraded deployment does not strand them.
   */
  async findPendingReferenceOlderThan(
    now: Date,
    limit: number,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<WagerTransaction[]> {
    const legacyCutoff = new Date(now.getTime() - 5 * 60 * 1000);
    return (em ?? this.em).find(WagerTransaction, {
      status: WagerTransactionStatus.PendingReference,
      $or: [
        { nextAttemptAt: { $lte: now } },
        { nextAttemptAt: null, createdAt: { $lte: legacyCutoff } },
      ],
    } as any, { limit, orderBy: { nextAttemptAt: 'ASC', createdAt: 'ASC' } });
  }

  async save(tx: WagerTransaction, em?: EntityManager<PostgreSqlDriver>): Promise<void> {
    (em ?? this.em).persist(tx);
  }

  async lockById(id: string, em?: EntityManager<PostgreSqlDriver>): Promise<WagerTransaction | null> {
    const targetEm = em ?? this.em;
    // Lock first, then read: see MikroOrmWalletRepository.lockById.
    await targetEm.getConnection().execute(
      `SELECT id FROM wager_transactions WHERE id = ? FOR UPDATE`,
      [id],
      'run',
      targetEm.getTransactionContext(),
    );
    return targetEm.findOne(WagerTransaction, { id });
  }
}
