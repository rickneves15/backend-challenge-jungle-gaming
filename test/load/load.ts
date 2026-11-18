/**
 * Real load test for the wagering processor.
 *
 * Usage: bun run test:load
 * Tunables: LOAD_TOTAL, LOAD_CONCURRENCY, LOAD_WALLETS, LOAD_AMOUNT,
 *           LOAD_WALLET_BALANCE, LOAD_REPLAY_SAMPLE.
 *
 * It starts the real NestJS application (background workers disabled, exactly
 * like the concurrency tests), creates the configured wallets, submits unique
 * transactions through HTTP with bounded concurrency, then samples replay and
 * conflict behaviour. The final report includes throughput, p50/p95/p99,
 * status counts, idempotent replays, conflicts, outbox lag, the in-process
 * metrics snapshot and the balance == ledger invariant for every wallet.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { WagerTransactionKind } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity';
import { MetricsService } from '@/shared/infrastructure/observability/metrics.service';
import { setupTestDb, cleanDb, teardownTestDb } from '../integration/db-helper.ts';
import {
  assertBalanceMatchesLedger,
  createWalletHttp,
  startTestApp,
  submitHttp,
} from '../concurrency/helpers.ts';

const TOTAL = positiveInt('LOAD_TOTAL', 200);
const CONCURRENCY = positiveInt('LOAD_CONCURRENCY', 20);
const WALLETS = positiveInt('LOAD_WALLETS', 8);
const AMOUNT = process.env.LOAD_AMOUNT ?? '1.00';
const WALLET_BALANCE = process.env.LOAD_WALLET_BALANCE ?? '1000.00';
const REPLAY_SAMPLE = positiveInt('LOAD_REPLAY_SAMPLE', Math.min(10, Math.ceil(TOTAL * 0.05)));

interface SubmitBody {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
}

interface Sample {
  status: number;
  ms: number;
  code?: string;
  idempotentReplay?: boolean;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function timedSubmit(baseUrl: string, body: SubmitBody): Promise<Sample> {
  const started = performance.now();
  try {
    const response = await submitHttp(baseUrl, body);
    const json = (await response.json()) as {
      code?: string;
      idempotentReplay?: boolean;
    };
    return {
      status: response.status,
      ms: performance.now() - started,
      ...(json.code ? { code: json.code } : {}),
      ...(json.idempotentReplay ? { idempotentReplay: true } : {}),
    };
  } catch (error) {
    return { status: 0, ms: performance.now() - started, code: 'TRANSPORT_ERROR' };
  }
}

async function runPool(baseUrl: string, jobs: SubmitBody[]): Promise<Sample[]> {
  const results: Sample[] = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= jobs.length) return;
      results.push(await timedSubmit(baseUrl, jobs[index]!));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(1, jobs.length)) }, () => worker()),
  );
  return results;
}

function countBy(samples: Sample[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples) {
    const key = String(sample.status);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

async function outboxLag(orm: MikroORM<PostgreSqlDriver>) {
  const em = orm.em.fork();
  const pending = await em.find(OutboxMessage, { publishedAt: null });
  const now = Date.now();
  const lags = pending.map((row) => Math.max(0, now - row.occurredAt.getTime()));
  const total = lags.reduce((acc, value) => acc + value, 0);
  return {
    pending: pending.length,
    maxLagMs: lags.length ? Math.max(...lags) : 0,
    avgLagMs: lags.length ? Math.round(total / lags.length) : 0,
  };
}

async function main(): Promise<void> {
  const orm = await setupTestDb();
  await cleanDb(orm);
  const { app, baseUrl } = await startTestApp();

  try {
    const walletIds: string[] = [];
    for (let i = 0; i < WALLETS; i += 1) {
      const id = randomUUID();
      const response = await createWalletHttp(baseUrl, {
        id,
        playerId: `load-player-${i}`,
        amount: WALLET_BALANCE,
      });
      if (!response.ok) {
        throw new Error(`failed to create wallet ${id}: ${response.status} ${await response.text()}`);
      }
      walletIds.push(id);
    }

    const jobs: SubmitBody[] = Array.from({ length: TOTAL }, (_, i) => {
      const walletId = walletIds[i % walletIds.length]!;
      return {
        providerId: 'load-provider',
        externalTransactionId: `load-tx-${i}`,
        walletId,
        playerId: `load-player-${i % walletIds.length}`,
        kind: WagerTransactionKind.Bet,
        money: { amount: AMOUNT, currency: 'BRL' },
      };
    });

    const setupDone = performance.now();
    const baseline = await runPool(baseUrl, jobs);
    const elapsedMs = performance.now() - setupDone;

    // Replay an existing key (same payload -> 200 + idempotentReplay) and then
    // the same key with a different amount (-> 409 IDEMPOTENCY_CONFLICT).
    const replayJobs = jobs.slice(0, REPLAY_SAMPLE);
    const replays = await runPool(
      baseUrl,
      replayJobs.map((job) => ({ ...job })),
    );
    const conflicts = await runPool(
      baseUrl,
      replayJobs.map((job) => ({ ...job, money: { ...job.money, amount: '99.00' } })),
    );

    const all = [...baseline, ...replays, ...conflicts];
    const latencies = all.map((sample) => sample.ms).sort((a, b) => a - b);
    const failures = baseline.filter(
      (sample) => ![200, 202, 409, 422].includes(sample.status),
    );
    const invariants = await Promise.all(
      walletIds.map((walletId) => assertBalanceMatchesLedger(orm, walletId)),
    );

    const report = {
      generatedAt: new Date().toISOString(),
      config: {
        total: TOTAL,
        concurrency: CONCURRENCY,
        wallets: WALLETS,
        amount: AMOUNT,
        walletBalance: WALLET_BALANCE,
        replaySample: REPLAY_SAMPLE,
      },
      throughputRps: Number((TOTAL / (elapsedMs / 1000)).toFixed(2)),
      baselineDurationMs: Math.round(elapsedMs),
      latencyMs: {
        count: latencies.length,
        min: Number(latencies[0]?.toFixed(2) ?? 0),
        avg: Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)),
        p50: Number(percentile(latencies, 50).toFixed(2)),
        p95: Number(percentile(latencies, 95).toFixed(2)),
        p99: Number(percentile(latencies, 99).toFixed(2)),
        max: Number(latencies.at(-1)?.toFixed(2) ?? 0),
      },
      statusCounts: countBy(all),
      baselineStatusCounts: countBy(baseline),
      errorRate: Number((failures.length / TOTAL).toFixed(4)),
      idempotentReplays: replays.filter((sample) => sample.idempotentReplay).length,
      conflicts: conflicts.filter((sample) => sample.status === 409 && sample.code === 'IDEMPOTENCY_CONFLICT').length,
      outbox: await outboxLag(orm),
      metrics: app.get(MetricsService).snapshot(),
      invariant: {
        walletsChecked: invariants.length,
        balances: invariants.map((item) => item.balance),
      },
    };

    console.log(JSON.stringify(report, null, 2));
    if (failures.length > 0) {
      console.error(
        `load test failed: ${failures.length} unexpected responses ` +
          JSON.stringify(failures.slice(0, 5)),
      );
      process.exitCode = 1;
    }
  } finally {
    await app.close();
    await teardownTestDb(orm);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
