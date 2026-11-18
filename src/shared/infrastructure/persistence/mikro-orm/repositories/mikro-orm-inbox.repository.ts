import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { InboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/inbox-message.entity';
import type { InboxRepository } from '@/shared/kernel/ports/inbox-repository.port';

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager<PostgreSqlDriver>) {}

  async findByMessage(
    consumerName: string,
    messageId: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<InboxMessage | null> {
    return (em ?? this.em).findOne(InboxMessage, { consumerName, messageId });
  }

  async save(msg: InboxMessage, em?: EntityManager<PostgreSqlDriver>): Promise<void> {
    (em ?? this.em).persist(msg);
  }
}
