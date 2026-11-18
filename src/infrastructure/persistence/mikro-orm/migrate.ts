import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { mikroOrmConfig } from '../../../mikro-orm.config';

type MigrationAction = 'up' | 'down' | 'fresh';

const ACTIONS: readonly MigrationAction[] = ['up', 'down', 'fresh'];

function parseAction(value: string | undefined): MigrationAction {
  const action = (value ?? 'up').toLowerCase();
  if (!ACTIONS.includes(action as MigrationAction)) {
    throw new Error(
      `Unknown migration action "${value}". Expected one of: ${ACTIONS.join(', ')}`,
    );
  }
  return action as MigrationAction;
}

async function run(action: MigrationAction): Promise<void> {
  const orm = await MikroORM.init<PostgreSqlDriver>(mikroOrmConfig as any);
  const migrator = orm.getMigrator();

  try {
    if (action === 'down') {
      await migrator.down();
    } else if (action === 'fresh') {
      // MikroORM v6 has no `fresh()` action: roll back everything, then apply
      // every migration from an empty schema. Never silently fall back to `up`.
      while ((await migrator.getExecutedMigrations()).length > 0) {
        await migrator.down();
      }
      await migrator.up();
    } else {
      await migrator.up();
    }
    console.log(`Migration ${action} completed successfully`);
  } catch (err) {
    console.error(`Migration ${action} failed:`, err);
    process.exitCode = 1;
  } finally {
    await orm.close(true);
  }
}

let action: MigrationAction;
try {
  action = parseAction(process.argv[2]);
} catch (err) {
  console.error(String(err));
  process.exit(1);
}

void run(action);
