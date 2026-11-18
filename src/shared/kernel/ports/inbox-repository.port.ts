import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { InboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/inbox-message.entity';

export interface InboxRepository {
  findByMessage(
    consumerName: string,
    messageId: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<InboxMessage | null>;
  save(msg: InboxMessage, em?: EntityManager<PostgreSqlDriver>): Promise<void>;
}
