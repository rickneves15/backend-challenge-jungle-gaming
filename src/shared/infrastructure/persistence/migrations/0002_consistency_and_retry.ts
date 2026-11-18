import { Migration } from '@mikro-orm/migrations';

/**
 * Closes the gaps that cannot be enforced in application code alone:
 * - schema-level non-negativity, enum domains and ledger immutability;
 * - persistent retry state for out-of-order references;
 * - replay balance snapshot;
 * - nullable next_attempt_at so an outbox row can be moved to a logical DLQ.
 */
export class Migration20260102000000_consistency_and_retry extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wallets
      ADD CONSTRAINT wallets_balance_non_negative
      CHECK (balance_amount::numeric >= 0);
    `);

    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT wallet_ledger_entries_direction_check
      CHECK (direction IN ('DEBIT', 'CREDIT'));
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_transactions_kind_check
      CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_transactions_status_check
      CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN IF NOT EXISTS reference_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS balance_snapshot_amount TEXT,
      ADD COLUMN IF NOT EXISTS balance_snapshot_currency VARCHAR(3);
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS wager_transactions_pending_reference_due_idx
      ON wager_transactions (status, next_attempt_at);
    `);

    this.addSql(`ALTER TABLE outbox_messages ALTER COLUMN next_attempt_at DROP NOT NULL;`);

    this.addSql(`
      CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet ledger entries are immutable (attempted %)', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      DROP TRIGGER IF EXISTS wallet_ledger_entries_immutable ON wallet_ledger_entries;
      CREATE TRIGGER wallet_ledger_entries_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entries_immutable ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS reject_ledger_mutation();`);
    this.addSql(`ALTER TABLE outbox_messages ALTER COLUMN next_attempt_at SET NOT NULL;`);
    this.addSql(`DROP INDEX IF EXISTS wager_transactions_pending_reference_due_idx;`);
    this.addSql(`
      ALTER TABLE wager_transactions
      DROP COLUMN IF EXISTS balance_snapshot_currency,
      DROP COLUMN IF EXISTS balance_snapshot_amount,
      DROP COLUMN IF EXISTS next_attempt_at,
      DROP COLUMN IF EXISTS reference_attempts;
    `);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_transactions_status_check;`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_transactions_kind_check;`);
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_direction_check;`);
    this.addSql(`ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_balance_non_negative;`);
  }
}
