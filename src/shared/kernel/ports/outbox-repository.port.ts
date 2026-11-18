import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity';

export interface OutboxRepository {
  save(msg: OutboxMessage, em?: EntityManager<PostgreSqlDriver>): Promise<void>;
  findPendingDue(
    now: Date,
    limit: number,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<OutboxMessage[]>;
  markPublished(
    msg: OutboxMessage,
    at: Date,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<void>;
  scheduleRetry(
    msg: OutboxMessage,
    now: Date,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<void>;
  markDead(
    msg: OutboxMessage,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<void>;
  /**
   * Atomically claims one unpublished row. `publishedAt` is supplied by the
   * caller so the SQL claim value and the entity value cannot drift.
   */
  lockUnpublishedById(
    id: string,
    publishedAt: Date,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<OutboxMessage | null>;
  lockById(id: string, em?: EntityManager<PostgreSqlDriver>): Promise<OutboxMessage | null>;
}
