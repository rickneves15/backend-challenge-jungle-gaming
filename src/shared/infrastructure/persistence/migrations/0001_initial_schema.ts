import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        player_id VARCHAR(255) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_amount TEXT NOT NULL,
        balance_currency VARCHAR(3) NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS wallets_player_id_currency_unique
      ON wallets (player_id, currency);
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS wallets_player_id_idx ON wallets (player_id);
    `);

    this.addSql(`
      CREATE TABLE IF NOT EXISTS wager_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id VARCHAR(255) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id VARCHAR(255) NOT NULL,
        player_id VARCHAR(255) NOT NULL,
        round_id VARCHAR(255) NOT NULL,
        game_id VARCHAR(255) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        money_amount TEXT NOT NULL,
        money_currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(255),
        status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
        reference_transaction_id VARCHAR(255),
        failure_code VARCHAR(64),
        processed_at TIMESTAMPTZ,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS wager_transactions_idempotency_key_unique
      ON wager_transactions (idempotency_key);
    `);

    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS wager_transactions_provider_external_unique
      ON wager_transactions (provider_id, external_transaction_id);
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS wager_transactions_wallet_id_idx ON wager_transactions (wallet_id);
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS wager_transactions_status_idx ON wager_transactions (status);
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS wager_transactions_round_id_idx ON wager_transactions (round_id);
    `);

    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_id VARCHAR(255) NOT NULL,
        transaction_id VARCHAR(255) NOT NULL,
        direction VARCHAR(6) NOT NULL,
        money_amount TEXT NOT NULL,
        money_currency VARCHAR(3) NOT NULL,
        balance_before_amount TEXT NOT NULL,
        balance_before_currency VARCHAR(3) NOT NULL,
        balance_after_amount TEXT NOT NULL,
        balance_after_currency VARCHAR(3) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_entries_transaction_id_unique
      ON wallet_ledger_entries (transaction_id);
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS wallet_ledger_entries_wallet_id_idx ON wallet_ledger_entries (wallet_id);
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS wallet_ledger_entries_transaction_id_idx ON wallet_ledger_entries (transaction_id);
    `);

    this.addSql(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id VARCHAR(255) NOT NULL,
        consumer_name VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS inbox_messages_consumer_name_message_id_unique
      ON inbox_messages (consumer_name, message_id);
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS inbox_messages_consumer_name_processed_at_idx
      ON inbox_messages (consumer_name, processed_at);
    `);

    this.addSql(`
      CREATE TABLE IF NOT EXISTS outbox_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        aggregate_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(255) NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ
      );
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS outbox_messages_published_at_idx ON outbox_messages (published_at);
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS outbox_messages_next_attempt_at_idx ON outbox_messages (next_attempt_at);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallets CASCADE;`);
  }
}
