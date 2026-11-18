import { Migration } from '@mikro-orm/migrations';

/**
 * Final integrity hardening:
 * - persisted rejection reasons (F-13);
 * - no dead FAILED status in the database enum (F-14);
 * - real UUID/FK constraints for concrete references (F-25);
 * - durable metric snapshots (F-20).
 *
 * `outbox_messages.aggregate_id` is polymorphic, so a plain FK cannot be used.
 * A trigger validates it against the table implied by `event_type` instead.
 */
export class Migration20260103000000_integrity_and_durable_metrics extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN IF NOT EXISTS failure_reason TEXT;
    `);

    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_transactions_status_check;`);
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_transactions_status_check
      CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED'));
    `);

    // Existing values must be valid UUIDs. A failure here is preferable to
    // silently keeping logical-only relations.
    this.addSql(`
      ALTER TABLE wager_transactions
      ALTER COLUMN wallet_id TYPE UUID USING wallet_id::uuid,
      ALTER COLUMN reference_transaction_id TYPE UUID USING
        CASE WHEN reference_transaction_id IS NULL OR reference_transaction_id = ''
             THEN NULL ELSE reference_transaction_id::uuid END;
    `);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ALTER COLUMN wallet_id TYPE UUID USING wallet_id::uuid,
      ALTER COLUMN transaction_id TYPE UUID USING transaction_id::uuid;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_transactions_wallet_id_fkey
      FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE RESTRICT;
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_transactions_reference_transaction_id_fkey
      FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id) ON DELETE RESTRICT;
    `);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT wallet_ledger_entries_wallet_id_fkey
      FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE RESTRICT;
    `);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT wallet_ledger_entries_transaction_id_fkey
      FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id) ON DELETE RESTRICT;
    `);

    this.addSql(`
      CREATE OR REPLACE FUNCTION assert_outbox_aggregate_exists() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'WalletBalanceChanged' THEN
          IF NOT EXISTS (SELECT 1 FROM wallets WHERE id = NEW.aggregate_id::uuid) THEN
            RAISE EXCEPTION 'outbox aggregate % does not exist in wallets', NEW.aggregate_id;
          END IF;
        ELSE
          IF NOT EXISTS (
            SELECT 1 FROM wager_transactions WHERE id = NEW.aggregate_id::uuid
          ) THEN
            RAISE EXCEPTION 'outbox aggregate % does not exist in wager_transactions', NEW.aggregate_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      DROP TRIGGER IF EXISTS outbox_messages_aggregate_exists ON outbox_messages;
      CREATE TRIGGER outbox_messages_aggregate_exists
      BEFORE INSERT OR UPDATE OF aggregate_id, event_type ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION assert_outbox_aggregate_exists();
    `);

    this.addSql(`
      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id UUID PRIMARY KEY,
        instance_id VARCHAR(255) NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      );
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS metric_snapshots_recorded_at_idx
      ON metric_snapshots (recorded_at DESC);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS metric_snapshots_recorded_at_idx;`);
    this.addSql(`DROP TABLE IF EXISTS metric_snapshots;`);

    this.addSql(`DROP TRIGGER IF EXISTS outbox_messages_aggregate_exists ON outbox_messages;`);
    this.addSql(`DROP FUNCTION IF EXISTS assert_outbox_aggregate_exists();`);

    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_transaction_id_fkey;`);
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_wallet_id_fkey;`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_transactions_reference_transaction_id_fkey;`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_transactions_wallet_id_fkey;`);

    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ALTER COLUMN transaction_id TYPE VARCHAR(255) USING transaction_id::text,
      ALTER COLUMN wallet_id TYPE VARCHAR(255) USING wallet_id::text;
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
      ALTER COLUMN reference_transaction_id TYPE VARCHAR(255) USING reference_transaction_id::text,
      ALTER COLUMN wallet_id TYPE VARCHAR(255) USING wallet_id::text;
    `);

    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_transactions_status_check;`);
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_transactions_status_check
      CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));
    `);
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN IF EXISTS failure_reason;`);
  }
}
