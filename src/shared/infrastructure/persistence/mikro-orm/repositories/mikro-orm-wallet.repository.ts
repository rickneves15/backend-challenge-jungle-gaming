import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { Wallet } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet.entity';
import type { WalletRepository } from '@/shared/kernel/ports/wallet-repository.port';

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager<PostgreSqlDriver>) {}

  async findById(id: string, em?: EntityManager<PostgreSqlDriver>): Promise<Wallet | null> {
    return (em ?? this.em).findOne(Wallet, { id });
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<Wallet | null> {
    return (em ?? this.em).findOne(Wallet, { playerId, currency });
  }

  async save(wallet: Wallet, em?: EntityManager<PostgreSqlDriver>): Promise<void> {
    (em ?? this.em).persist(wallet);
  }

  async lockById(id: string, em?: EntityManager<PostgreSqlDriver>): Promise<Wallet | null> {
    const targetEm = em ?? this.em;
    // Lock BEFORE reading the entity. If we read first, a concurrent
    // transaction that commits while we wait for the lock leaves us with a
    // stale balance in the identity map and both debits succeed. MikroORM uses
    // `?` placeholders (rewritten to `$1`) and needs the transaction context
    // so the row lock is held until COMMIT.
    await targetEm.getConnection().execute(
      `SELECT id FROM wallets WHERE id = ? FOR UPDATE`,
      [id],
      'run',
      targetEm.getTransactionContext(),
    );
    return targetEm.findOne(Wallet, { id });
  }

  async lockForCreation(
    playerId: string,
    currency: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<void> {
    const targetEm = em ?? this.em;
    // Transaction-scoped advisory lock: concurrent wallet-open requests for the
    // same natural key wait here, so the duplicate pre-check cannot race.
    await targetEm.getConnection().execute(
      `SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))`,
      [playerId, currency],
      'run',
      targetEm.getTransactionContext(),
    );
  }
}
