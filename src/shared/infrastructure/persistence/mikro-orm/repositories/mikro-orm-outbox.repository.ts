import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity';
import type { OutboxRepository } from '@/shared/kernel/ports/outbox-repository.port';

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager<PostgreSqlDriver>) {}

  async save(msg: OutboxMessage, em?: EntityManager<PostgreSqlDriver>): Promise<void> {
    (em ?? this.em).persist(msg);
  }

  async findPendingDue(
    now: Date,
    limit: number,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<OutboxMessage[]> {
    return (em ?? this.em).find(OutboxMessage, {
      publishedAt: null,
      nextAttemptAt: { $lte: now },
    }, { limit, orderBy: { nextAttemptAt: 'ASC' } });
  }

  async markPublished(msg: OutboxMessage, at: Date, em?: EntityManager<PostgreSqlDriver>): Promise<void> {
    msg.markPublished(at);
    (em ?? this.em).persist(msg);
  }

  async scheduleRetry(msg: OutboxMessage, now: Date, em?: EntityManager<PostgreSqlDriver>): Promise<void> {
    msg.scheduleRetry(now);
    (em ?? this.em).persist(msg);
  }

  async markDead(msg: OutboxMessage, em?: EntityManager<PostgreSqlDriver>): Promise<void> {
    msg.markDead();
    (em ?? this.em).persist(msg);
  }

  async lockById(
    id: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<OutboxMessage | null> {
    const targetEm = em ?? this.em;
    await targetEm.getConnection().execute(
      `SELECT id FROM outbox_messages WHERE id = ? FOR UPDATE`,
      [id],
      'run',
      targetEm.getTransactionContext(),
    );
    return targetEm.findOne(OutboxMessage, { id });
  }

  async lockUnpublishedById(
    id: string,
    publishedAt: Date,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<OutboxMessage | null> {
    const targetEm = em ?? this.em;
    // Atomic claim: UPDATE ... WHERE published_at IS NULL. PostgreSQL serializes
    // competing UPDATEs on the same row, and the second one re-checks the WHERE
    // after the first commits, so exactly one publisher receives the row.
    // The timestamp comes from the worker's clock, not SQL now(), so the row
    // and the entity flushed after publication carry exactly the same value.
    const claimed = await targetEm.getConnection().execute(
      `UPDATE outbox_messages
         SET published_at = ?
       WHERE id = ? AND published_at IS NULL
       RETURNING id`,
      [publishedAt, id],
      'all',
      targetEm.getTransactionContext(),
    );
    if (!claimed?.length) return null;

    // The row is already marked published in this transaction; load it without
    // the publishedAt filter so the ORM can hand the worker a managed entity.
    return targetEm.findOne(OutboxMessage, { id });
  }
}
