/**
 * Writes financial state in a separate OS process, then exits. The parent
 * test opens a brand-new ORM connection and verifies the final invariant,
 * proving the state survives a full service restart.
 *
 * Usage: bun test/concurrency/restart-writer.ts <walletId>
 */
import { WagerTransactionKind } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity.ts';
import {
  buildServices,
  createWallet,
  submitTx,
  setupConcurrencyDb,
  teardownConcurrencyDb,
} from './helpers.ts';

const [walletId] = process.argv.slice(2);
const orm = await setupConcurrencyDb();
const services = buildServices(orm);

await createWallet(services, {
  id: walletId,
  playerId: 'restart-player',
  amount: '100.00',
});
await submitTx(services, {
  walletId,
  playerId: 'restart-player',
  externalTransactionId: 'restart-bet-1',
  amount: '25.00',
});
await submitTx(services, {
  walletId,
  playerId: 'restart-player',
  externalTransactionId: 'restart-win-1',
  kind: WagerTransactionKind.Win,
  amount: '10.00',
});

console.log(`RESULT:${JSON.stringify({ walletId, written: true })}`);
await teardownConcurrencyDb(orm);
