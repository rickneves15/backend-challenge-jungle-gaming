# Jungle Gaming — Distributed Wagering Processor

Technical challenge solution: a distributed financial service that processes wagering transactions from multiple game providers.

## Stack

| Item                      | Choice                         |
| ------------------------- | ------------------------------ |
| Runtime / package manager | **Bun 1.x**                    |
| Language                  | **TypeScript** strict mode     |
| Framework                 | **NestJS**                     |
| Database                  | **PostgreSQL**                 |
| Messaging                 | **AWS SQS** via **LocalStack** |
| ORM                       | **MikroORM**                   |
| Local orchestration       | **Docker Compose**             |

## Getting started

### Prerequisites

- Bun 1.x
- Docker & Docker Compose

### 1. Configure the environment

```bash
cp .env.example .env
```

The defaults point to the services started by Docker Compose (`localhost:5432` for PostgreSQL and
`localhost:4566` for LocalStack). Inside Compose the application uses `PGHOST=postgres` and
`SQS_ENDPOINT=http://localstack:4566`.

### 2. Start the stack

```bash
docker compose up -d
```

This starts PostgreSQL, LocalStack (with the SQS FIFO queues `wager-transactions.fifo` and
`wager-transactions-dlq.fifo`) and the application on port 3000. The app waits for both dependency
healthchecks before starting.

### 3. Install dependencies and migrate (local runtime)

```bash
bun install
bun run migrate:up
```

When running through Docker Compose the migrations are applied with `bun run migrate:up` before
starting the app. For a local run, apply them yourself as shown above.

### 4. Run the application locally

```bash
bun run start:dev   # watch mode
bun run start:prod  # Bun runs src/main.ts directly (no dist path mismatch)
```

The API is served under `http://localhost:3000/api`. Health checks are deliberately **outside**
that prefix: `http://localhost:3000/health/live` and `/health/ready`.

### Worker roles

Background loops are opt-in via `WORKER_ROLES` so an API replica does not silently also consume
SQS, publish the outbox, sweep pending references and export metrics. The value is a comma-separated
list of `sqs-consumer`, `outbox`, `pending-references` and `metrics-snapshot`; the default empty value
starts no loops, while `WORKER_ROLES=all` starts every loop. Docker Compose uses `all` so the single
container keeps the original all-in-one behaviour. Separate roles can be assigned to separate
replicas for independent scaling.

### Available scripts

| Script                     | Description                                              |
| -------------------------- | -------------------------------------------------------- |
| `bun run start`            | Start the app                                            |
| `bun run start:dev`        | Start in watch mode                                      |
| `bun run start:prod`       | Start with Bun directly from TypeScript sources          |
| `bun run build`            | Compile TypeScript (typecheck/verification)              |
| `bun run migrate:up`       | Run migrations up                                        |
| `bun run migrate:down`     | Run migrations down                                      |
| `bun run migrate:fresh`    | Roll back all migrations and reapply them from scratch   |
| `bun test`                 | Run all tests                                            |
| `bun run test:unit`        | Run unit tests                                           |
| `bun run test:integration` | Run integration tests                                    |
| `bun run test:concurrency` | Run contention, crash-recovery and outbox race tests     |
| `bun run test:load`        | Run the real HTTP load test and print a JSON report      |

## API endpoints

### Health and metrics (no authentication)

- `GET /health/live` — liveness check (process is up)
- `GET /health/ready` — readiness check (PostgreSQL + SQS reachable; returns 503 when a dependency fails)
- `GET /api/metrics` — in-process counters, gauges and latency histograms
- `GET /api/metrics/snapshots` — durable snapshots written by replicas
- `POST /api/metrics/snapshots/flush` — persist this process's current metrics snapshot

### Wallets

- `POST /api/wallets` — create a wallet
- `GET /api/wallets/:walletId` — get wallet balance and version
- `GET /api/wallets/:walletId/ledger?cursor=&limit=` — paginated ledger entries (opaque keyset cursor)
- `POST /api/wallets/:walletId/reconciliation` — reconcile stored vs calculated balance

### Wagering transactions

- `POST /api/wagering/transactions` — submit a wagering transaction
- `GET /api/wagering/transactions/:transactionId` — get transaction by internal ID
- `GET /api/providers/:providerId/wagering/transactions/:externalTransactionId` — get transaction by provider + external ID

### Submit transaction body

```http
POST /api/wagering/transactions
Idempotency-Key: provider-a:transaction-123
Content-Type: application/json
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": "previous-tx"
}
```

`Idempotency-Key` is **required**; there is no client fallback. `payloadHash` is always computed on
the server from the business fields with a canonical (recursively key-sorted) SHA-256, so clients
cannot send it — sending `idempotencyKey` or `payloadHash` in the body is rejected by the validation
pipe. `OPENING` is internal and cannot be submitted. `REFUND` and `ROLLBACK` require
`referenceExternalTransactionId`.

### HTTP status mapping

| Situation                                             | Status | `code` example                  |
| ----------------------------------------------------- | ------ | ------------------------------- |
| Invalid payload / missing header                      | 400    | `MISSING_IDEMPOTENCY_KEY`       |
| Same idempotency key with different payload           | 409    | `IDEMPOTENCY_CONFLICT`          |
| Duplicate wallet                                      | 409    | `WALLET_ALREADY_EXISTS`         |
| Wallet or transaction not found                       | 404    | `WALLET_NOT_FOUND`              |
| Business rejection (persisted, terminal)              | 422    | `INSUFFICIENT_BALANCE`          |
| Reference not yet available                           | 202    | `PENDING_REFERENCE`             |
| Transient infrastructure failure                      | 502    | `INFRASTRUCTURE_ERROR`          |

Business rejections are persisted with `status: REJECTED`, a `failureCode`, and a
`WagerTransactionRejected` event. An idempotent replay returns the original outcome (including the
original balance snapshot), so the status of a replay is the status of the first submission.

Note: when creating a wallet, the currency is taken from `initialBalance.currency`; there is no
separate `currency` field in the request body.

## Using `request.http`

The repository ships a [`request.http`](./request.http) file with ready-to-run requests for every
flow: health checks, wallet creation, BET/WIN/LOSS/REFUND/ROLLBACK, idempotency replay and
conflict, out-of-order references, transaction lookups, and reconciliation.

## Testing

Unit tests run without infrastructure. Integration, concurrency and load tests require
PostgreSQL and LocalStack running.

```bash
bun test                         # all tests
bun run test:unit                # unit tests only
bun run test:integration         # integration tests
bun run test:concurrency         # contention, crash-recovery and outbox race tests
bun run test:load                # real load test (see below)
bunx tsc --noEmit -p test/tsconfig.json  # typecheck tests (@/ aliases via test/tsconfig.json)
```

The load test starts the real Nest app, creates the configured wallets and submits HTTP transactions
with bounded concurrency. It prints a JSON report with throughput, p50/p95/p99, status counts,
error rate, idempotent replays, conflicts, outbox lag and the balance == ledger invariant. Tune it
with `LOAD_TOTAL`, `LOAD_CONCURRENCY`, `LOAD_WALLETS`, `LOAD_AMOUNT`, `LOAD_WALLET_BALANCE` and
`LOAD_REPLAY_SAMPLE`. Background workers are disabled during the run, so `outbox.pending` is the
accumulated publication backlog and `outbox.maxLagMs` is the age of the oldest unpublished event.

## Project structure

```
src/
  main.ts                       # Bootstrap (filters, prefix, shutdown hooks)
  app.module.ts                 # Root module (global config + filters)
  mikro-orm.config.ts           # MikroORM configuration
  shared/
    kernel/                     # Global KernelModule, DI tokens, ports, WorkerRuntime
    domain/                     # rules/, errors/, events/, value-objects/
    dto/                        # Shared request DTOs (Money)
    infrastructure/
      auth/                     # NoOpAuthGuard (F-01 intentionally open)
      http/                     # Domain error filter
      observability/            # Metrics, durable snapshots, snapshot worker
      persistence/
        migrations/             # 0001 initial, 0002 consistency, 0003 integrity/metrics
        mikro-orm/              # Entities, repositories, unit of work
        persistence.module.ts
  modules/
    wallets/                    # controllers/, dto/, services/open-wallet.use-case.ts
    wagering/                   # controllers/, dto/, services/ (submit + pending refs)
    reconciliation/             # controllers/, services/reconcile-wallet.use-case.ts
  infrastructure/
    health/                     # /health/live and /health/ready
    messaging/                  # Shared SQS client provider/token
    sqs-consumer/               # SQS consumer + outbox worker
    workers/                    # Pending-reference sweep worker
    persistence/                # DatabaseModule + migrate.ts
test/
  unit/                         # Domain, error and finding-specific unit tests
  integration/                  # PostgreSQL-backed integration tests
  concurrency/                  # Contention, crash-recovery and outbox races
  load/                         # Real HTTP load test
```
