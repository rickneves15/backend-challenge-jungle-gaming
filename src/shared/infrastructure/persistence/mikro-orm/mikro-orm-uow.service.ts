import { Injectable, Logger as NestLogger, Inject } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import type { TransactionOptions } from '@/shared/kernel/ports/unit-of-work.port';

@Injectable()
export class MikroOrmUnitOfWork {
  private readonly logger = new NestLogger(MikroOrmUnitOfWork.name);

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM<PostgreSqlDriver>,
  ) {}

  get em(): EntityManager<PostgreSqlDriver> {
    return this.orm.em;
  }

  /**
   * Executes a callback inside a SQL transaction. If the callback throws,
   * the transaction is rolled back automatically.
   *
   * Every call gets its own clean EntityManager fork. MikroORM's default
   * `em.transactional()` forks the global EM with `clear: false`, which copies
   * its identity map into the transaction. Under real concurrency that means a
   * second transaction can read a stale entity from the identity map even
   * AFTER acquiring a row lock and after the first transaction committed.
   * Isolating the fork keeps `SELECT ... FOR UPDATE` + `findOne()` honest and
   * also prevents concurrent merges back into the shared global identity map.
   */
  async transactional<T>(
    fn: (em: EntityManager<PostgreSqlDriver>) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const em = this.orm.em.fork({ clear: true });
    return em.transactional(async (ctx) => {
      try {
        return await fn(ctx);
      } catch (err) {
        this.logger.error('Transaction rolled back due to error', { error: String(err) });
        throw err;
      }
    }, options);
  }

  fork(): EntityManager<PostgreSqlDriver> {
    return this.orm.em.fork();
  }
}
