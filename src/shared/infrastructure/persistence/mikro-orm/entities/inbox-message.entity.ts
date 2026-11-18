import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Index,
} from '@mikro-orm/core';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  id: string;
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

@Entity({ tableName: 'inbox_messages' })
@Unique({ properties: ['consumerName', 'messageId'] })
@Index({ properties: ['consumerName', 'processedAt'] })
export class InboxMessage {
  @PrimaryKey({ type: 'uuid' })
  id: string;

  @Property({ type: 'varchar', length: 255 })
  messageId: string;

  @Property({ type: 'varchar', length: 255 })
  consumerName: string;

  @Property({ type: 'varchar', length: 64 })
  payloadHash: string;

  @Property({ type: 'date', defaultRaw: 'now()' })
  receivedAt: Date;

  @Property({ type: 'date', nullable: true })
  processedAt: Date | undefined;

  constructor(props: ReceiveInboxProps) {
    this.id = crypto.randomUUID();
    this.messageId = props.messageId;
    this.consumerName = props.consumerName;
    this.payloadHash = props.payloadHash;
    this.receivedAt = props.receivedAt ?? new Date();
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    const msg = new InboxMessage({
      messageId: state.messageId,
      consumerName: state.consumerName,
      payloadHash: state.payloadHash,
      receivedAt: state.receivedAt,
    });
    msg.id = state.id;
    msg.processedAt = state.processedAt;
    return msg;
  }

  isProcessed(): boolean {
    return !!this.processedAt;
  }

  /** Detects a reused message id whose bytes changed after first receipt. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    this.processedAt = at;
  }
}
