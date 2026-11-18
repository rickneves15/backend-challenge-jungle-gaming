import { Inject, Injectable, Optional } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import type {
  WalletRepository,
  WagerTransactionRepository,
  LedgerEntryRepository,
  OutboxRepository,
  Clock,
  IdGenerator,
  Logger,
  UnitOfWork,
} from '@/shared/kernel/ports';
import {
  CLOCK,
  ID_GENERATOR,
  LEDGER_ENTRY_REPOSITORY,
  LOGGER,
  OUTBOX_REPOSITORY,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY,
} from '@/shared/kernel/ports/tokens';
import { MetricsService } from '@/shared/infrastructure/observability/metrics.service';
import { Wallet } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet.entity';
import { WagerTransaction } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  affectsBalance,
  requiresReference,
  validReferenceKinds,
} from '@/shared/domain/rules/wager-rules';
import { WalletLedgerEntry } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.entity';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity';
import { Money } from '@/shared/domain/value-objects/money';
import { LedgerDirection, ledgerDirectionOpposite } from '@/shared/domain/value-objects/ledger-direction';
import {
  WalletNotFoundError,
  CurrencyMismatchError,
  ReferenceMismatchError,
  ValueMismatchError,
  IdempotencyConflictError,
  DuplicateReferenceReversalError,
  ReferenceNotFoundError,
  InsufficientBalanceError,
  ReversalWouldOverdrawError,
  DomainError,
  isBusinessRejection,
} from '@/shared/domain/errors/domain-error';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionPendingReference,
  WagerTransactionRejected,
  EventContext,
} from '@/shared/domain/events/integration-event';

export interface SubmitWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  /** Always computed server-side by the entry point from a canonical payload. */
  payloadHash: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface SubmitWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
  failureCode?: string;
  reason?: string;
}

export interface SubmitOptions {
  /**
   * Reuse an already-open SQL transaction (SQS inbox + wager must be atomic).
   * When omitted the use case opens its own transaction.
   */
  em?: EntityManager<PostgreSqlDriver>;
}

type EntityManagerForWager = EntityManager<PostgreSqlDriver>;

const REFERENCE_MAX_ATTEMPTS = 10;
const REFERENCE_RETRY_BASE_MS = 60_000;
const REFERENCE_RETRY_MAX_MS = 3_600_000;
const LOCK_CONTENTION_THRESHOLD_MS = 50;

function isReversal(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

function nextReferenceDelay(attempts: number): number {
  return Math.min(REFERENCE_RETRY_BASE_MS * 2 ** attempts, REFERENCE_RETRY_MAX_MS);
}

/**
 * Submits (or finishes) a wager inside one SQL transaction.
 *
 * Invariants to preserve when editing this class:
 * - `walletId` is the concurrency unit: the wallet is locked BEFORE any read
 *   that decides the outcome.
 * - Wallet, transaction, ledger, inbox (when supplied) and outbox writes share
 *   the same EntityManager, so a committed balance change cannot lose events.
 * - Business violations are persisted as REJECTED with a failureCode and an
 *   event inside the same transaction; they are never silent rollbacks.
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly txRepo: WagerTransactionRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledgerRepo: LedgerEntryRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outboxRepo: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(LOGGER) private readonly logger: Logger,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  async execute(input: SubmitWagerTransactionInput, options?: SubmitOptions): Promise<SubmitWagerTransactionOutput> {
    const startedAt = Date.now();
    try {
      const run = async (em: EntityManagerForWager): Promise<SubmitWagerTransactionOutput> => {
        const now = this.clock.now();

        // OPENING is internal: it is created by OpenWalletUseCase only.
        if (input.kind === WagerTransactionKind.Opening) {
          throw new DomainError('OPENING_NOT_SUBMITTABLE', 'OPENING is an internal kind', 400);
        }

        // Pessimistic lock on the concurrency unit BEFORE any decision read.
        const lockStartedAt = Date.now();
        const wallet = await this.walletRepo.lockById(input.walletId, em);
        if (!wallet) {
          throw new WalletNotFoundError(input.walletId);
        }
        const lockMs = Date.now() - lockStartedAt;
        if (lockMs > LOCK_CONTENTION_THRESHOLD_MS) {
          this.metrics?.inc('lock_conflicts');
          this.logger.warn('Wallet lock contention', { walletId: input.walletId, waitedMs: lockMs });
        }

        const existingByKey = await this.txRepo.findByIdempotencyKey(input.idempotencyKey, em);
        if (existingByKey) {
          if (!existingByKey.matchesPayload(input.payloadHash)) {
            this.logger.warn('Idempotency conflict', {
              idempotencyKey: input.idempotencyKey,
              walletId: input.walletId,
            });
            throw new IdempotencyConflictError(input.idempotencyKey);
          }

          if (existingByKey.status !== WagerTransactionStatus.PendingReference) {
            this.metrics?.inc('duplicates_detected');
            return this.buildReplayOutput(existingByKey, true);
          }

          return this.processTransaction(existingByKey, wallet, input, now, em, true);
        }

        const tx = WagerTransaction.create({
          id: this.idGenerator.generate(),
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          payloadHash: input.payloadHash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money: input.money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
        });

        return this.processTransaction(tx, wallet, input, now, em, false);
      };

      return options?.em ? await run(options.em) : await this.uow.transactional(run);
    } finally {
      this.metrics?.observe('processing_latency_ms', Date.now() - startedAt, { kind: input.kind });
    }
  }

  /** Shared validation/apply path for first submissions and PENDING_REFERENCE retries. */
  private async processTransaction(
    tx: WagerTransaction,
    wallet: Wallet,
    input: SubmitWagerTransactionInput,
    now: Date,
    em: EntityManagerForWager,
    isReplay: boolean,
  ): Promise<SubmitWagerTransactionOutput> {
    try {
      if (wallet.currency !== input.money.currency) {
        throw new CurrencyMismatchError(wallet.currency, input.money.currency);
      }

      let referenceTx: WagerTransaction | null = null;
      if (requiresReference(input.kind)) {
        const referenceExternalTransactionId = input.referenceExternalTransactionId!;
        referenceTx = await this.txRepo.findByProviderAndExternal(
          input.providerId,
          referenceExternalTransactionId,
          em,
        );
        if (!referenceTx || referenceTx.status !== WagerTransactionStatus.Processed) {
          return this.handleMissingReference(tx, wallet, input, now, em, isReplay);
        }

        const validKinds = validReferenceKinds(input.kind);
        if (!validKinds.includes(referenceTx.kind)) {
          throw new ReferenceMismatchError(referenceExternalTransactionId);
        }
        if (
          referenceTx.playerId !== input.playerId ||
          referenceTx.walletId !== input.walletId ||
          referenceTx.moneyCurrency !== input.money.currency ||
          referenceTx.roundId !== input.roundId
        ) {
          throw new ReferenceMismatchError(referenceExternalTransactionId);
        }

        const reversalExists = await this.txRepo.findReversal(referenceTx.id, input.kind, em);
        if (reversalExists && reversalExists.id !== tx.id) {
          throw new DuplicateReferenceReversalError(referenceExternalTransactionId, input.kind);
        }

        if (!Money.from(input.money).equals(referenceTx.money)) {
          throw new ValueMismatchError('money', referenceTx.money.amount, input.money.amount);
        }
      }

      let ledgerEntry: WalletLedgerEntry | undefined;
      let balanceChanged = false;
      if (input.kind !== WagerTransactionKind.Loss && affectsBalance(input.kind)) {
        const direction =
          input.kind === WagerTransactionKind.Rollback && referenceTx
            ? ledgerDirectionOpposite(referenceTx.ledgerDirectionFor())
            : tx.ledgerDirectionFor(referenceTx ?? undefined);

        let result;
        if (direction === LedgerDirection.Debit) {
          try {
            result = wallet.debit(Money.from(input.money));
          } catch (err) {
            if (err instanceof InsufficientBalanceError && isReversal(input.kind)) {
              throw new ReversalWouldOverdrawError(
                wallet.id,
                wallet.balance.amount,
                input.money.amount,
              );
            }
            throw err;
          }
        } else {
          result = wallet.credit(Money.from(input.money));
        }

        ledgerEntry = WalletLedgerEntry.create({
          id: this.idGenerator.generate(),
          walletId: input.walletId,
          transactionId: tx.id,
          direction: result.direction,
          money: { amount: result.money.amount, currency: result.money.currency },
          balanceBefore: { amount: result.balanceBefore.amount, currency: result.balanceBefore.currency },
          balanceAfter: { amount: result.balanceAfter.amount, currency: result.balanceAfter.currency },
          createdAt: now,
        });
        balanceChanged = true;
      }

      // Rule 7.7: the response on replay must be the balance observed now.
      tx.setBalanceSnapshot(wallet.toSnapshot());
      tx.markProcessed(referenceTx?.id, now);

      await this.walletRepo.save(wallet, em);
      await this.txRepo.save(tx, em);
      // Entities are linked by raw UUID, so flush the transaction before its
      // ledger entry and before the outbox trigger checks aggregate existence.
      await em.flush();
      if (ledgerEntry) {
        await this.ledgerRepo.save(ledgerEntry, em);
        await em.flush();
      }
      await this.enqueueOutboxEvents(tx, wallet, ledgerEntry, now, balanceChanged, isReplay, em);

      this.metrics?.inc('transactions_by_status', { status: tx.status });
      this.logger.info('Wager transaction processed', {
        transactionId: tx.id,
        kind: input.kind,
        status: tx.status,
        walletId: input.walletId,
        providerId: input.providerId,
        idempotentReplay: isReplay,
      });

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: tx.balanceSnapshot ?? wallet.toSnapshot(),
        idempotentReplay: isReplay,
      };
    } catch (err) {
      if (isBusinessRejection(err)) {
        return this.rejectTransaction(tx, wallet, err, now, em, isReplay);
      }
      throw err;
    }
  }

  /**
   * Missing reference: keep the transaction auditable as PENDING_REFERENCE and
   * schedule the next attempt with exponential backoff. Once the budget is
   * exhausted it becomes REJECTED with REFERENCE_NOT_FOUND (rule 7.1).
   */
  private async handleMissingReference(
    tx: WagerTransaction,
    wallet: Wallet,
    input: SubmitWagerTransactionInput,
    now: Date,
    em: EntityManagerForWager,
    isReplay: boolean,
  ): Promise<SubmitWagerTransactionOutput> {
    if (tx.referenceAttempts + 1 >= REFERENCE_MAX_ATTEMPTS) {
      const error = new ReferenceNotFoundError(
        input.providerId,
        input.referenceExternalTransactionId ?? '',
      );
      tx.setBalanceSnapshot(wallet.toSnapshot());
      tx.reject(error.code, now, error.message);
      await this.txRepo.save(tx, em);
      await em.flush();
      await this.enqueueRejection(tx, wallet, error.code, error.message, now, em);
      this.metrics?.inc('transactions_by_status', { status: tx.status });
      return {
        transactionId: tx.id,
        status: tx.status,
        balance: tx.balanceSnapshot ?? wallet.toSnapshot(),
        idempotentReplay: isReplay,
        failureCode: error.code,
        reason: error.message,
      };
    }

    if (!isReplay) {
      tx.markPendingReference();
      await this.txRepo.save(tx, em);
      await em.flush();
      await this.savePendingReferenceOutbox(tx, now, em);
    }
    tx.recordReferenceAttempt(now, new Date(now.getTime() + nextReferenceDelay(tx.referenceAttempts)));
    await this.txRepo.save(tx, em);
    this.metrics?.inc('retries', { reason: 'pending_reference' });

    return {
      transactionId: tx.id,
      status: WagerTransactionStatus.PendingReference,
      balance: wallet.toSnapshot(),
      idempotentReplay: isReplay,
    };
  }

  /** Persists a business rejection and its integration event atomically. */
  private async rejectTransaction(
    tx: WagerTransaction,
    wallet: Wallet,
    error: DomainError,
    now: Date,
    em: EntityManagerForWager,
    isReplay: boolean,
  ): Promise<SubmitWagerTransactionOutput> {
    tx.setBalanceSnapshot(wallet.toSnapshot());
    tx.reject(error.code, now, error.message);
    await this.txRepo.save(tx, em);
    await em.flush();
    await this.enqueueRejection(tx, wallet, error.code, error.message, now, em);
    this.metrics?.inc('transactions_by_status', { status: tx.status });
    this.logger.warn('Wager transaction rejected', {
      transactionId: tx.id,
      walletId: inputWalletId(wallet),
      failureCode: error.code,
    });
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: tx.balanceSnapshot ?? wallet.toSnapshot(),
      idempotentReplay: isReplay,
      failureCode: error.code,
      reason: error.message,
    };
  }

  private async savePendingReferenceOutbox(
    tx: WagerTransaction,
    now: Date,
    em: EntityManagerForWager,
  ): Promise<void> {
    await this.outboxRepo.save(
      OutboxMessage.enqueue({
        aggregateId: tx.id,
        eventType: 'WagerTransactionPendingReference',
        payload: WagerTransactionPendingReference.from({
          transactionId: tx.id,
          walletId: tx.walletId,
          playerId: tx.playerId,
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          kind: tx.kind,
          referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
          ctx: this.eventContext(tx, now),
        }).toJSON(),
        occurredAt: now,
      }),
      em,
    );
  }

  private eventContext(tx: WagerTransaction, now: Date): EventContext {
    return { correlationId: tx.id, causationId: tx.referenceTransactionId, occurredAt: now };
  }

  private async enqueueOutboxEvents(
    tx: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | undefined,
    now: Date,
    balanceChanged: boolean,
    idempotentReplay: boolean,
    em: EntityManagerForWager,
  ): Promise<void> {
    const ctx = this.eventContext(tx, now);
    await this.outboxRepo.save(
      OutboxMessage.enqueue({
        aggregateId: tx.id,
        eventType: 'WagerTransactionProcessed',
        payload: WagerTransactionProcessed.from({
          transactionId: tx.id,
          walletId: tx.walletId,
          playerId: tx.playerId,
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          kind: tx.kind,
          money: tx.money.toJSON(),
          idempotentReplay,
          ctx,
        }).toJSON(),
        occurredAt: now,
      }),
      em,
    );

    if (balanceChanged && ledgerEntry) {
      await this.outboxRepo.save(
        OutboxMessage.enqueue({
          aggregateId: tx.walletId,
          eventType: 'WalletBalanceChanged',
          payload: WalletBalanceChanged.from(
            tx.walletId,
            tx.id,
            {
              direction: ledgerEntry.direction,
              money: ledgerEntry.money.toJSON(),
              balanceBefore: ledgerEntry.balanceBefore.toJSON(),
              balanceAfter: ledgerEntry.balanceAfter.toJSON(),
            },
            wallet.version,
            ctx,
          ).toJSON(),
          occurredAt: now,
        }),
        em,
      );
    }
  }

  private async enqueueRejection(
    tx: WagerTransaction,
    wallet: Wallet,
    failureCode: string,
    reason: string,
    now: Date,
    em: EntityManagerForWager,
  ): Promise<void> {
    await this.outboxRepo.save(
      OutboxMessage.enqueue({
        aggregateId: tx.id,
        eventType: 'WagerTransactionRejected',
        payload: WagerTransactionRejected.from({
          transactionId: tx.id,
          walletId: tx.walletId,
          playerId: tx.playerId,
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          kind: tx.kind,
          money: tx.money.toJSON(),
          failureCode,
          reason,
          ctx: this.eventContext(tx, now),
        }).toJSON(),
        occurredAt: now,
      }),
      em,
    );
  }

  private buildReplayOutput(
    tx: WagerTransaction,
    idempotentReplay: boolean,
  ): SubmitWagerTransactionOutput {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: tx.balanceSnapshot ?? null,
      idempotentReplay,
      failureCode: tx.failureCode,
      reason: tx.failureReason,
    };
  }
}

function inputWalletId(wallet: Wallet): string {
  return wallet.id;
}
