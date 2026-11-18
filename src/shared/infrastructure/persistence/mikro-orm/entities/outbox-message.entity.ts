import {
  Entity,
  PrimaryKey,
  Property,
  Index,
} from '@mikro-orm/core';

import { nextBackoffMs } from '@/shared/domain/rules/outbox-rules';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: string;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export interface EnqueueOutboxProps {
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}

@Entity({ tableName: 'outbox_messages' })
@Index({ properties: ['publishedAt'] })
@Index({ properties: ['nextAttemptAt'] })
export class OutboxMessage {
  @PrimaryKey({ type: 'uuid' })
  id: string;

  @Property({ type: 'varchar', length: 255 })
  aggregateId: string;

  @Property({ type: 'varchar', length: 255 })
  eventType: string;

  @Property({ type: 'text' })
  payload: string;

  @Property({ type: 'date', defaultRaw: 'now()' })
  occurredAt: Date;

  @Property({ type: 'number', default: 0 })
  attempts: number;

  @Property({ type: 'date', nullable: true })
  nextAttemptAt: Date | undefined;

  @Property({ type: 'date', nullable: true })
  publishedAt: Date | undefined;

  constructor(aggregateId: string, eventType: string, payload: string, occurredAt: Date) {
    this.id = crypto.randomUUID();
    this.aggregateId = aggregateId;
    this.eventType = eventType;
    this.payload = payload;
    this.occurredAt = occurredAt;
    this.attempts = 0;
    this.nextAttemptAt = occurredAt;
    this.publishedAt = undefined;
  }

  static enqueue(props: EnqueueOutboxProps): OutboxMessage {
    return new OutboxMessage(
      props.aggregateId,
      props.eventType,
      JSON.stringify(props.payload),
      props.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    const msg = new OutboxMessage(
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
    );
    msg.id = state.id;
    msg.attempts = state.attempts;
    msg.nextAttemptAt = state.nextAttemptAt;
    msg.publishedAt = state.publishedAt;
    return msg;
  }

  get attemptsValue(): number {
    return this.attempts;
  }

  isPending(): boolean {
    return this.publishedAt === undefined;
  }

  markPublished(at: Date): void {
    this.publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    this.attempts += 1;
    this.nextAttemptAt = new Date(now.getTime() + nextBackoffMs(this.attempts));
  }

  /**
   * Moves the message to a logical dead-letter state. A dead message has no
   * nextAttemptAt, so findPendingDue() never selects it again. This avoids an
   * extra column/migration while keeping the row for inspection.
   */
  markDead(): void {
    this.nextAttemptAt = undefined;
  }

  getPayload(): Record<string, unknown> {
    return JSON.parse(this.payload) as Record<string, unknown>;
  }
}
