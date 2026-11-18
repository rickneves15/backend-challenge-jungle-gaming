# Architecture Decisions — Distributed Wagering Processor

This document describes the technical decisions, design rationale, trade-offs, and limitations of the solution.

---

## 1. Overview

The system is a distributed financial service that processes wagering transactions (BET, WIN, LOSS, REFUND, ROLLBACK) received from multiple game providers. It guarantees:

- **Financial correctness**: exact decimal arithmetic, no `number`/`float` for money.
- **Concurrency correctness**: no lost updates, no duplicate credits/debits, no negative balance.
- **Persistent idempotency**: no in-memory-only dedup.
- **Ledger consistency**: materialized balance always equals ledger reconstruction.
- **Transactional outbox**: events are persisted atomically with financial changes and published after commit.
- **Crash recovery**: redelivery-safe, ack only after commit.

---

## 2. Stack and justification

| Item                                    | Choice                         | Justification                                                                                                             |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Runtime / package manager / test runner | **Bun 1.x**                    | Fast runtime and test runner, required by the challenge.                                                                  |
| Language                                | **TypeScript strict mode**     | Type safety for financial logic.                                                                                          |
| Framework                               | **NestJS**                     | Required by the challenge; modular, decorator-based.                                                                      |
| Database                                | **PostgreSQL**                 | ACID transactions, row-level locking, reliable for financial ledger.                                                      |
| Messaging                               | **AWS SQS** via **LocalStack** | Required; at-least-once delivery, FIFO queues available locally.                                                          |
| ORM                                     | **MikroORM**                   | Preferred option: Unit of Work, Identity Map, `EntityManager.transactional()`, explicit pessimistic locking (`LockMode`). |
| Local orchestration                     | **Docker Compose**             | Single-command local stack (PostgreSQL + LocalStack).                                                                     |
| Migrations                              | **MikroORM Migrations**        | Versioned and reversible SQL migrations.                                                                                  |

### Why MikroORM over TypeORM

MikroORM provides an explicit **Unit of Work** and **Identity Map**, which are essential to keep wallet, ledger, inbox, and outbox consistent within a single SQL transaction. Its `EntityManager.transactional()` API and pessimistic lock support map directly to the challenge's concurrency requirements.

### Why Prisma is not used

The challenge explicitly excludes Prisma and other ORMs. MikroORM's entity-centric approach allows the domain model (rich entities with behavior) to stay close to the persistence layer without sacrificing encapsulation.

---

## 3. Domain model

### 3.1 Money (value object)

- **Immutable**: every operation returns a new instance; `Object.freeze` at runtime.
- **Internal storage**: `decimal.js-light` `Decimal` with precision 28, `ROUND_HALF_UP`.
- **Input/output**: always decimal string with fixed scale 2 (e.g. `"25.00"`).
- **No `number`/`float`/`double`** is ever used for money anywhere in the codebase.
- **Validation**: rejects `NaN`, `Infinity`, scientific notation, empty string, more than 2 decimal places, negative values in input contracts.
- **Currency**: ISO-4217 3 uppercase letters; operations between different currencies throw a domain error.
- **Persistence**: stored in two columns (`amount` TEXT, `currency` VARCHAR) and rehydrated via `Money.from()`.

### 3.2 Wallet (aggregate root)

- Private constructor + static factories `open()` and `rehydrate()`.
- `rehydrate()` does **not** revalidate business transitions; it only reconstructs already-persisted state.
- Invariants:
  - At most one wallet per `playerId` + `currency` (DB unique constraint).
  - Balance never negative (enforced in `debit()` and DB).
  - Every balance change has a corresponding ledger entry (and vice versa).
  - Currency of operation must equal wallet currency.
  - `version` starts at 1 and increments only when balance changes.

### 3.3 WagerTransaction

- Kinds: `OPENING` (internal), `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.
- Statuses: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.
- Business rejections are **persisted** as `REJECTED` with a `failureCode` and a `WagerTransactionRejected` event; they are terminal and auditable, not just HTTP responses.
- Replays return the persisted outcome, including the original `balanceSnapshotAmount`/`balanceSnapshotCurrency`, so the caller always sees the result of the first submission.
- Terminal statuses: `PROCESSED`, `REJECTED`, `FAILED`. Transitioning from a terminal state is a programming error.
- `OPENING` is internal only; cannot be submitted via API or SQS.
- Same idempotency key with different payload = conflict, not replay.
- `requiresReference()`: true for `REFUND` and `ROLLBACK`.
- `affectsBalance()`: false for `LOSS`.
- `ledgerDirectionFor(reference)`: for `ROLLBACK`, returns the opposite of the reference's direction.

### 3.4 WalletLedgerEntry (immutable)

- No mutable fields, no transition methods.
- `create()` validates `balanceBefore ± money === balanceAfter`.
- At most one ledger entry per transaction (DB unique constraint on `transactionId`).
- `LOSS` and `REJECTED` transactions produce no ledger entry.

### 3.5 Inbox and Outbox

- **Inbox**: deduplication by `(consumerName, messageId)`; `processedAt` marks completion.
- **Outbox**: `attempts`, `nextAttemptAt` (exponential backoff), `publishedAt`.
- Inbox, financial change, ledger, and outbox participate in the **same SQL transaction**.

---

## 4. Concurrency strategy

The concurrency unit is **`walletId`**.

**Strategy: pessimistic locking (`SELECT ... FOR UPDATE`) on the wallet row.**

Flow per transaction:
1. Lock the wallet row with `SELECT ... FOR UPDATE`.
2. Validate currency, balance, idempotency, reference.
3. Apply debit/credit to the wallet aggregate.
4. Persist wallet, transaction, ledger entry, and outbox messages in the same SQL transaction.
5. Commit releases the lock.

### Why pessimistic locking

- Simple, correct, and enforced by PostgreSQL (works across multiple application instances).
- No in-memory lock (satisfies restriction #6: no global shared lock).
- Different wallets are processed in parallel because locks are per-row.
- The `version` column provides optimistic-concurrency awareness, but the actual mutual exclusion comes from the row lock.

### Mandatory scenario

Initial balance `100.00 BRL`, two concurrent `BET` of `80.00 BRL`:
1. Both lock the wallet row sequentially.
2. First bet debits `80.00` → balance `20.00`, `PROCESSED`.
3. Second bet attempts debit `80.00` → `20.00 - 80.00 < 0` → `InsufficientBalanceError` → `REJECTED`.
4. Final balance `20.00`, exactly one ledger debit entry, no duplicate debit from retries.

---

## 5. Idempotency (persistent)

- `Idempotency-Key` header is **mandatory**; there is no generated client fallback. The client also cannot supply `idempotencyKey` or `payloadHash` in the body — `forbidNonWhitelisted` rejects them.
- `wager_transactions.idempotencyKey` has a **DB unique constraint**.
- `payloadHash` is always computed server-side as SHA-256 of a stable JSON serialization (keys sorted at **every** nesting level) of the business field subset; transport metadata and headers are excluded. Recursive sorting matters: a replacer array would drop nested keys like `money.amount` and make different amounts collide.
- Same key + same payload → replay returns original result (`idempotentReplay: true`), no balance/ledger change.
- Same key + different payload → `IDEMPOTENCY_CONFLICT` (HTTP 409), not replay.
- SQS inbox: `inbox_messages` has unique constraint on `(consumerName, messageId)`.
- Ack (delete from SQS) happens **only after** the SQL transaction commits.

---

## 6. Transactional outbox

All integration events are written to `outbox_messages` in the **same SQL transaction** as the financial changes. Events are **never** published before commit.

**OutboxWorker**:
- Polls for pending, due events.
- Multiple publisher instances can run concurrently because each outbox row is re-loaded inside a transaction; a concurrent publisher that already published will skip (row marked `publishedAt`).
- Published events get a SQS `MessageDeduplicationId` = outbox row id, so duplicate delivery is safe for consumers.

### Crash recovery scenario

1. PostgreSQL commits.
2. Process dies before publishing.
3. Another instance's OutboxWorker picks up the pending row.
4. Event is published to SQS.
5. Duplicate publication is safe (consumer-side idempotency via inbox/dedup).

---

## 7. SQS processing

The `SqsConsumerService`:

- Reuses the **same `SubmitWagerTransactionUseCase`** as the HTTP entry point for
  `WagerTransactionRequested` commands (envelope `{ messageId, type, occurredAt, data }`).
- Routes by message type: the outbox integration events published to the same queue
  (`WagerTransactionProcessed`, `WalletBalanceChanged`, ...) are **notifications**, not commands.
  They are recorded in the inbox and acknowledged with no financial effect, which also makes a
  duplicate publication safe. Treating them as commands used to crash on `data.idempotencyKey`.
- Deduplicates via persistent inbox by `(consumerName, messageId)`.
- Acks (deletes from SQS) **only after commit**.
- Distinguishes:
  - **Business errors** (terminal) → ack, no retry.
  - **Transient errors** → message stays in queue, redelivered after visibility timeout.
  - **Permanent errors** → DLQ after max receive count.
- Supports redelivery without duplicating effects (inbox + idempotency).
- On `SIGTERM`, in-flight messages complete or visibility is returned.

---

## 8. Out-of-order references

`REFUND` and `ROLLBACK` require `referenceExternalTransactionId`.

- If the referenced transaction is not found (or not yet `PROCESSED`), the new transaction is persisted as `PENDING_REFERENCE` and a `WagerTransactionPendingReference` outbox event is emitted.
- Each failed lookup increments `referenceAttempts` and schedules `nextAttemptAt` with exponential backoff. `ProcessPendingReferencesUseCase` (scheduled worker, `PENDING_REFERENCE_POLL_INTERVAL_MS` default 60s) only reprocesses rows whose deadline has elapsed, reusing the same submit use case with the original idempotency key and hash.
- Rows written before the retry columns existed remain eligible after a legacy grace period, so an upgrade does not strand them.
- After the attempt limit / TTL, the transaction is `REJECTED` with `REFERENCE_NOT_FOUND` and an event is published.

---

## 9. Failure code taxonomy

| Failure code                   | Meaning                                                        | Provider action                         |
| ------------------------------ | -------------------------------------------------------------- | --------------------------------------- |
| `INSUFFICIENT_BALANCE`         | Bet would make balance negative                                | Retry with lower amount or do not retry |
| `DUPLICATE_REFERENCE_REVERSAL` | Reference already reversed by this kind                        | Do not retry                            |
| `REFERENCE_NOT_FOUND`          | Referenced transaction not found or not processed              | Retry later (reference may arrive)      |
| `REFERENCE_MISMATCH`           | Reference does not match provider/player/wallet/currency/round | Correct payload, do not retry           |
| `VALUE_MISMATCH`               | Refund/Rollback amount differs from reference                  | Correct payload, do not retry           |
| `REVERSAL_WOULD_OVERDRAW`      | A reversal would overdraw the wallet                          | Do not retry                            |
| `REFERENCE_REQUIRED`           | REFUND/ROLLBACK without `referenceExternalTransactionId`       | Correct payload, do not retry           |
| `IDEMPOTENCY_CONFLICT`         | Same idempotency key, different payload                        | Correct payload, do not retry           |
| `CURRENCY_MISMATCH`            | Operation currency differs from wallet currency                | Correct payload, do not retry           |
| `TRANSACTION_TERMINAL`         | Transaction already in terminal state                          | Do not retry                            |
| `INFRASTRUCTURE_ERROR`         | Transient infrastructure failure                               | Retry                                   |

HTTP mapping (a single `DomainErrorFilter` owns it, so every endpoint agrees):

| Status | Meaning                                                       |
| ------ | ------------------------------------------------------------- |
| 400    | Invalid payload or invalid domain/cursor state                 |
| 404    | Resource not found                                            |
| 409    | Idempotency conflict or duplicate wallet                      |
| 422    | Business rejection (`INSUFFICIENT_BALANCE`, mismatch, ...)    |
| 202    | `PENDING_REFERENCE` (accepted, not yet settled)               |
| 502    | Transient infrastructure failure                              |

`IDEMPOTENCY_CONFLICT` and duplicate wallets remain 409 because they are conflicts with an existing
request, not business rejections of a valid request.

---

## 10. Database schema (constraints at SQL level)

All invariants from restriction #9 are enforced in the schema, not only in application code:

- `wallets`: `UNIQUE (player_id, currency)` — one wallet per player + currency.
- `wager_transactions`: `UNIQUE (idempotency_key)` — persistent idempotency.
- `wager_transactions`: `UNIQUE (provider_id, external_transaction_id)` — one transaction per provider + external id.
- `wallet_ledger_entries`: `UNIQUE (transaction_id)` — at most one ledger entry per transaction.
- `wallets.version`: optimistic-concurrency awareness column.
- `inbox_messages`: `UNIQUE (consumer_name, message_id)` — SQS dedup.
- `wallets.balance_amount` / `wallet_ledger_entries.money_amount`: TEXT columns for exact decimal storage.

---

## 11. Reconciliation

`POST /api/wallets/:walletId/reconciliation` compares the stored balance against the balance reconstructed by summing all ledger entries.

- Divergences are **not** silently corrected.
- They are logged, counted in metrics, and returned in the response with `consistent: false`.
- The response includes `storedBalance`, `calculatedBalance`, `difference`, `checkedEntries`.

---

## 12. Observability

- **Structured JSON logs** (pino) with `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` propagated via `AsyncLocalStorage`. Only identifiers are logged; full financial payloads and balances are never logged.
- **Health checks**: `/health/live` (process alive) and `/health/ready` (PostgreSQL + SQS reachable, 503 when unavailable). Both are outside `/api` and unauthenticated.
- **Metrics**: `GET /api/metrics` exposes counters (`transactions_by_status`, `duplicates_detected`, `retries`, `dlq_messages`, `lock_conflicts`, `reconciliation_mismatches`), gauges (`outbox_lag_ms`) and latency histograms (`processing_latency_ms`).
- OpenTelemetry and a dashboard are optional (not implemented).

---

## 13. Authentication (not scored)

Per the challenge section 2, authentication does **not** count toward the score and should not compete with financial correctness, concurrency, and idempotency.

### Decision

**Not implemented** in this version. No custom user table, no password hashing, no artisan auth.

### Design to adopt (if implemented later)

- Integrate an external Identity Provider (IdP) supporting OIDC/OAuth2: **Keycloak** (full OIDC, common in market) or **Zitadel** (lighter, API-first). Both run well in Docker Compose.
- The service would validate JWT access tokens issued by the IdP.
- Provider identity contained in SQS messages remains subject to domain validation regardless of auth.

### Explicit extension point in code

The codebase leaves a clear extension point:

1. **`AuthGuard` no-op**: HTTP endpoints currently have no guard. A custom NestJS `AuthGuard` can be applied globally or per-controller to validate the IdP JWT.
2. **`ProviderIdentityPort`**: an interface that abstracts provider identity resolution from the external IdP, so the domain use cases depend on the port, not on a concrete auth implementation.

These are documented in `ARCHITECTURE.md` and ready to be wired when authentication is prioritized.

---

## 14. Limitations

- The client cannot supply `payloadHash`: the server always computes it canonically from the business fields. This removes an entire class of hash mismatch bugs, at the cost of forcing all providers to send the exact same field set the server hashes.
- `bun run test:load` runs a real bounded-concurrency HTTP test and prints throughput/p50/p95/p99, but it runs against the local Docker stack rather than a distributed production topology.
- OpenTelemetry tracing is not implemented.
- The outbox worker publishes to SQS; a production deployment might use SNS or a dedicated event bus.
- The real SQS redelivery/DLQ path is smoke-tested against LocalStack; the automated failure suite stubs `sqs.send` for the outbox publish/retry/DLQ assertions.

---

## 15. Failure scenarios handled

| Scenario                                         | Handling                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Duplicate message                                | Inbox dedup + idempotency → no double effect                     |
| Out-of-order reference                           | `PENDING_REFERENCE` + scheduled reprocessing                     |
| Concurrent bets on same wallet                   | Pessimistic `FOR UPDATE` lock → exactly one succeeds             |
| Process dies after commit, before ack            | Message returns to queue; inbox dedup prevents double processing |
| Process dies after commit, before outbox publish | Outbox worker on another instance publishes the pending event    |
| Duplicate outbox publish                         | Deduplication ID + `publishedAt` mark → idempotent for consumer  |
| PostgreSQL/SQS temporarily unavailable           | Transient error → retry with backoff                             |

---

## 16. End-to-end request lifecycle

This section walks through the concrete call sequence for the main flows, so the behavior
described above can be traced in the code.

### 16.1 Opening a wallet

```text
POST /api/wallets { playerId, currency, initialBalance }
  -> WalletsController
  -> OpenWalletUseCase.execute()
     -> uow.transactional()
        -> walletRepo.findByPlayerAndCurrency()      // early duplicate check
        -> Wallet.open()                              // aggregate invariants
        -> if initialBalance > 0:
             WagerTransaction.create(kind: OPENING)
             wallet.credit(money)
             WalletLedgerEntry.create(CREDIT)
             txRepo.save + ledgerRepo.save
             outboxRepo.save(WagerTransactionProcessed)
             outboxRepo.save(WalletBalanceChanged)
        -> walletRepo.save()
  -> COMMIT (all rows become visible atomically)
```

If the initial balance is zero, no `OPENING` transaction, no ledger entry, and no balance event
are created.

### 16.2 Submitting a wager (HTTP and SQS share this path)

```text
POST /api/wagering/transactions  (Idempotency-Key header)
  or SQS message -> SqsConsumerService.processMessage()
  -> SubmitWagerTransactionUseCase.execute()

     [SQS only] inbox row persisted inside the same transaction

     -> uow.transactional()  ..................... fresh EntityManager fork
        -> walletRepo.lockById()  ................ SELECT ... FOR UPDATE
           (before any entity read, so the balance is never stale)
        -> txRepo.findByIdempotencyKey()
           |-> same hash + terminal status .......... replay original result
           |-> same hash + PENDING_REFERENCE ....... try to resolve reference again
           |-> different hash ...................... IDEMPOTENCY_CONFLICT
           (after the lock, so parallel duplicates observe the committed row
            instead of racing to INSERT and hitting the unique constraint)
        -> validate currency, reference kind/owner/status/value
        -> wallet.debit() or wallet.credit() ....... domain decides direction
        -> WalletLedgerEntry.create() .............. asserts balance arithmetic
        -> txRepo.save + ledgerRepo.save + outboxRepo.save(...)
     -> COMMIT

  [SQS only] delete message from queue AFTER commit
```

Key details: the row lock is acquired **inside** the transaction and **before** the first entity
read, so it is held until commit and the balance cannot be stale. The transaction runs on a clean
EntityManager fork: MikroORM's default `clear: false` would copy the global identity map and could
serve an outdated entity even after a lock was acquired. Two requests for the same wallet are
serialized by PostgreSQL; two requests for different wallets never block each other.

### 16.3 Reference arrives before the referenced transaction

```text
REFUND/ROLLBACK with unknown referenceExternalTransactionId
  -> reference lookup returns null
  -> tx.markPendingReference()                 // status PENDING_REFERENCE
  -> outbox: WagerTransactionPendingReference
  -> COMMIT (no balance change, no ledger entry)

Later: ProcessPendingReferencesUseCase (scheduled)
  -> loads PENDING_REFERENCE rows
  -> reuses SubmitWagerTransactionUseCase with the original input
     -> reference now found -> normal validation -> balance + ledger + events
     -> reference still missing -> replay, remains PENDING_REFERENCE
```

### 16.4 Outbox publication

```text
OutboxWorker.pollLoop()
  -> outboxRepo.findPendingDue(now, 20)
  -> publish(msg)
     -> uow.transactional()  (fresh EntityManager fork)
        -> outboxRepo.lockUnpublishedById(msg.id)
           -> UPDATE outbox_messages SET published_at = now()
              WHERE id = ? AND published_at IS NULL RETURNING id
           |-> no row (another instance claimed it) .. skip
           -> findOne(id) to load the claimed entity for the worker
        -> sqs.send(SendMessageCommand)
           MessageGroupId = aggregate-<aggregateId>
           MessageDeduplicationId = outbox row id
        -> outboxRepo.markPublished(fresh, now)
     -> COMMIT
  -> on failure: outboxRepo.scheduleRetry() + flush (exponential backoff)
              -> when attempts + 1 >= OUTBOX_MAX_ATTEMPTS: markDead() (logical DLQ)
```

The claim is an atomic `UPDATE ... WHERE published_at IS NULL RETURNING id`, not a
`SELECT ... FOR UPDATE` followed by `findOne()`. PostgreSQL serializes competing `UPDATE`s on the
same row: the second publisher blocks, re-evaluates the `WHERE` after the first commits, and gets
zero rows. This avoids the ORM identity map returning a stale "unpublished" entity to a concurrent
transaction.

### 16.5 Reconciliation

```text
POST /api/wallets/:walletId/reconciliation
  -> ReconcileWalletUseCase
     -> walletRepo.findById()                  // DomainError WALLET_NOT_FOUND if absent
     -> ledgerRepo.findByWallet() keyset pagination via opaque {t,id} cursor
        (createdAt DESC, id DESC; a timestamp-only cursor would drop rows with
         the same millisecond)
     -> calculated = sum(CREDIT) - sum(DEBIT)
     -> difference = calculated - stored balance
     -> consistent = difference == 0
     -> if inconsistent: reconciliation_mismatches counter + ERROR log with
        identifiers only (balances are never logged)
     -> return both balances + difference + checkedEntries
```

Divergences are reported, never silently repaired. A `WALLET_NOT_FOUND` domain error is mapped to
HTTP 404 by the global `DomainErrorFilter` checking the error **code**, not by matching message text.

---

## 17. Local deployment and load testing

`docker compose up -d` starts PostgreSQL, LocalStack and the application. The app container waits for
both dependency healthchecks, applies migrations (`bun run migrate:up`), then runs `src/main.ts` with
Bun. The LocalStack init script discovers the DLQ ARN at runtime instead of hardcoding an account id,
so the redrive policy is valid for whatever account LocalStack uses.

`bun run test:load` exercises the HTTP API with bounded concurrency and reports throughput,
p50/p95/p99, status counts, error rate, idempotent replays, conflicts, outbox lag and the
balance == ledger invariant. Workers are disabled during the run, so the outbox backlog is reported
as-is rather than being drained by a publisher.
