import { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

import { setupTestDb, cleanDb, teardownTestDb } from '../integration/db-helper.ts';
import { MikroOrmUnitOfWork } from '@/shared/infrastructure/persistence/mikro-orm/mikro-orm-uow.service.ts';
import { MikroOrmWalletRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository.ts';
import { MikroOrmWagerTransactionRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository.ts';
import { MikroOrmLedgerEntryRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger-entry.repository.ts';
import { MikroOrmOutboxRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository.ts';
import { MikroOrmInboxRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-inbox.repository.ts';
import { SystemClock, UuidIdGenerator, PinoLogger } from '@/shared/kernel/providers/kernel-providers.ts';
import { SubmitWagerTransactionUseCase } from '@/modules/wagering/services/submit-wager-transaction.use-case.ts';
import { OpenWalletUseCase } from '@/modules/wallets/services/open-wallet.use-case.ts';
import { ProcessPendingReferencesUseCase } from '@/modules/wagering/services/process-pending-references.use-case.ts';
import { PendingReferencesWorker } from '@/infrastructure/workers/pending-references-worker.service.ts';
import { SqsConsumerService } from '@/infrastructure/sqs-consumer/sqs-consumer.service.ts';
import { OutboxWorker } from '@/infrastructure/sqs-consumer/outbox-worker.service.ts';
import { Wallet } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet.entity.ts';
import { WalletLedgerEntry } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.entity.ts';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity.ts';
import { WagerTransactionKind } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity.ts';
import { AppModule } from '@/app.module.ts';
import { NoOpAuthGuard } from '@/shared/infrastructure/auth/no-op.auth.guard.ts';
import { MetricsService } from '@/shared/infrastructure/observability/metrics.service.ts';
import { WorkerRuntime } from '@/shared/kernel/worker-runtime.ts';

export type Services = ReturnType<typeof buildServices>;

/**
 * Wires the real use cases and workers against a real ORM instance, bypassing
 * Nest DI only so tests can trigger workers deterministically. Every database
 * operation still goes through the same repositories and transactions as the
 * running application.
 */
export function buildServices(orm: MikroORM<PostgreSqlDriver>) {
  const uow = new MikroOrmUnitOfWork(orm);
  const walletRepo = new MikroOrmWalletRepository(orm.em);
  const txRepo = new MikroOrmWagerTransactionRepository(orm.em);
  const ledgerRepo = new MikroOrmLedgerEntryRepository(orm.em);
  const outboxRepo = new MikroOrmOutboxRepository(orm.em);
  const inboxRepo = new MikroOrmInboxRepository(orm.em);
  const clock = new SystemClock();
  const ids = new UuidIdGenerator();
  const logger = new PinoLogger();
  const metrics = new MetricsService();
  const sqsStub = { send: async () => ({}) } as any;
  const workerRuntime = { isEnabled: () => false } as unknown as WorkerRuntime;
  // Honor the default value like the real ConfigService does, so workers use
  // the same consumer name / limits as production.
  const configStub = { get: (_key: string, defaultValue?: unknown) => defaultValue } as any;

  const submit = new SubmitWagerTransactionUseCase(
    uow, walletRepo, txRepo, ledgerRepo, outboxRepo, clock, ids, logger,
  );
  const openWallet = new OpenWalletUseCase(
    uow, walletRepo, txRepo, ledgerRepo, outboxRepo, clock, ids, logger,
  );
  const processPending = new ProcessPendingReferencesUseCase(
    txRepo, clock, logger, submit,
  );
  const pendingWorker = new PendingReferencesWorker(processPending, workerRuntime, logger);
  const outboxWorker = new OutboxWorker(
    sqsStub, '', configStub, workerRuntime, outboxRepo, uow, clock, logger, metrics,
  );
  const consumer = new SqsConsumerService(
    sqsStub, '', configStub, workerRuntime, submit, inboxRepo, uow, logger, metrics,
  );

  return {
    orm, uow, walletRepo, txRepo, ledgerRepo, outboxRepo, inboxRepo,
    clock, ids, logger, submit, openWallet, processPending, pendingWorker,
    outboxWorker, consumer,
  };
}

/**
 * Boots a real NestJS application on an ephemeral port with the same pipes and
 * guards as production. Background workers are stopped so they cannot mutate
 * outbox/inbox rows while a test is asserting on them.
 */
export async function startTestApp() {
  // Never start background loops in tests; workers are triggered explicitly.
  process.env.SQS_QUEUE_URL = '';
  process.env.WORKER_ROLES = '';
  const app: INestApplication = await NestFactory.create(AppModule, { logger: ['error'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.setGlobalPrefix('api');
  app.useGlobalGuards(new NoOpAuthGuard());
  await app.init();

  for (const worker of [OutboxWorker, SqsConsumerService, PendingReferencesWorker]) {
    await app.get(worker, { strict: false }).onModuleDestroy();
  }
  // Let any already-running poll iteration finish before tests start writing.
  await new Promise((resolve) => setTimeout(resolve, 100));

  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 3101;
  return { app, baseUrl: `http://127.0.0.1:${port}/api` };
}

/** POST /api/wallets through the real HTTP layer. */
export function createWalletHttp(
  baseUrl: string,
  opts: { id: string; playerId: string; amount?: string; currency?: string },
) {
  return fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: opts.id,
      playerId: opts.playerId,
      initialBalance: {
        amount: opts.amount ?? '100.00',
        currency: opts.currency ?? 'BRL',
      },
    }),
  });
}

/** POST /api/wagering/transactions with the given body (shared by parallel calls). */
export function submitHttp(
  baseUrl: string,
  body: {
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    playerId: string;
    roundId?: string;
    gameId?: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  },
) {
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
    },
    body: JSON.stringify({
      ...body,
      roundId: body.roundId ?? 'round-1',
      gameId: body.gameId ?? 'game-001',
    }),
  });
}

export async function setupConcurrencyDb() {
  return setupTestDb();
}

export async function cleanConcurrencyDb(orm: MikroORM<PostgreSqlDriver>) {
  await cleanDb(orm);
}

export async function teardownConcurrencyDb(orm: MikroORM<PostgreSqlDriver>) {
  await teardownTestDb(orm);
}

/** Opens a wallet through the same use case used by POST /api/wallets. */
export async function createWallet(
  services: Services,
  opts: { id: string; playerId: string; amount?: string; currency?: string },
) {
  return services.openWallet.execute({
    id: opts.id,
    playerId: opts.playerId,
    currency: opts.currency ?? 'BRL',
    initialBalance: {
      amount: opts.amount ?? '100.00',
      currency: opts.currency ?? 'BRL',
    },
  });
}

export interface SubmitOpts {
  walletId: string;
  playerId: string;
  externalTransactionId: string;
  idempotencyKey?: string;
  kind?: WagerTransactionKind;
  amount?: string;
  currency?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  providerId?: string;
}

/** Calls the production use case with a deterministic payload hash. */
export function submitTx(services: Services, opts: SubmitOpts) {
  const kind = opts.kind ?? WagerTransactionKind.Bet;
  const money = { amount: opts.amount ?? '10.00', currency: opts.currency ?? 'BRL' };
  const key = opts.idempotencyKey ?? `provider-1:${opts.externalTransactionId}`;
  // Both idempotencyKey and payloadHash are varchar(64) in the schema, so use
  // a stable fixed-length digest rather than concatenating the whole payload.
  const payloadHash = createHash('sha256')
    .update(`${key}:${kind}:${money.amount}:${opts.walletId}:${opts.roundId ?? 'round-1'}`)
    .digest('hex')
    .slice(0, 32);

  return services.submit.execute({
    providerId: opts.providerId ?? 'provider-1',
    externalTransactionId: opts.externalTransactionId,
    idempotencyKey: key,
    payloadHash,
    playerId: opts.playerId,
    walletId: opts.walletId,
    roundId: opts.roundId ?? 'round-1',
    gameId: 'game-001',
    kind,
    money,
    referenceExternalTransactionId: opts.referenceExternalTransactionId,
  });
}

/**
 * The invariant asserted by every financial test: the materialized balance
 * equals CREDIT - DEBIT reconstructed from the immutable ledger.
 */
export async function assertBalanceMatchesLedger(
  orm: MikroORM<PostgreSqlDriver>,
  walletId: string,
) {
  const em: EntityManager<PostgreSqlDriver> = orm.em.fork();
  const wallet = await em.findOne(Wallet, walletId);
  if (!wallet) throw new Error(`wallet ${walletId} not found`);

  const entries = await em.find(WalletLedgerEntry, { walletId });
  let credits = 0n;
  let debits = 0n;
  for (const entry of entries) {
    const cents = BigInt(entry.money.amount.replace('.', ''));
    if (entry.direction === 'CREDIT') credits += cents;
    else debits += cents;
  }

  const materialized = BigInt(wallet.balance.amount.replace('.', ''));
  if (materialized !== credits - debits) {
    throw new Error(
      `invariant violated for ${walletId}: balance=${materialized}, ledger=${credits - debits}`,
    );
  }
  return { balance: wallet.balance.amount, reconstructed:Number(credits - debits) / 100, entries: entries.length };
}

export async function ledgerCount(orm: MikroORM<PostgreSqlDriver>, walletId: string) {
  const em = orm.em.fork();
  return em.count(WalletLedgerEntry, { walletId });
}

export async function freshOutboxRow(orm: MikroORM<PostgreSqlDriver>, id: string) {
  const em = orm.em.fork();
  const row = await em.findOne(OutboxMessage, id);
  if (!row) throw new Error(`outbox row ${id} not found`);
  return row;
}
