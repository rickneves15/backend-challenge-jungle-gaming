import { Inject, Injectable } from '@nestjs/common';
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
import { Wallet } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet.entity';
import { WagerTransaction } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.entity';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity';
import { Money } from '@/shared/domain/value-objects/money';
import { LedgerDirection } from '@/shared/domain/value-objects/ledger-direction';
import { canonicalHash } from '@/shared/domain/value-objects/canonical-hash';
import {
  WalletAlreadyExistsError,
} from '@/shared/domain/errors/domain-error';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from '@/shared/domain/events/integration-event';
import { WagerTransactionKind } from '@/shared/domain/rules/wager-rules';

export interface OpenWalletInput {
  // Optional client-supplied id. When absent, a UUID is generated. Allowing an
  // explicit id makes wallet creation idempotent for callers such as request.http.
  id?: string;
  playerId: string;
  currency: string;
  initialBalance: { amount: string; currency: string };
}

export interface OpenWalletOutput {
  walletId: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
  openingTransactionId: string | null;
}

type EntityManagerForWallet = EntityManager<PostgreSqlDriver>;

/** PostgreSQL unique-index violation, possibly wrapped by the ORM driver. */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === '23505' || candidate.cause?.code === '23505';
}

@Injectable()
export class OpenWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly txRepo: WagerTransactionRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledgerRepo: LedgerEntryRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outboxRepo: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletOutput> {
    try {
      return await this.uow.transactional(async (em) => {
        const now = this.clock.now();

        // Serialize duplicate checks on the natural key. The unique index
        // remains the final guard; this converts the common race into a
        // deterministic domain error instead of a raw driver exception.
        await this.walletRepo.lockForCreation(input.playerId, input.currency, em);
        const existing = await this.walletRepo.findByPlayerAndCurrency(
          input.playerId,
          input.currency,
          em,
        );
        if (existing) {
          throw new WalletAlreadyExistsError(input.playerId, input.currency);
        }

        const walletId = input.id ?? this.idGenerator.generate();
        const money = Money.from(input.initialBalance);

        const wallet = Wallet.open({
          id: walletId,
          playerId: input.playerId,
          currency: input.currency,
          initialBalance: money,
        });

        // The wallet is the FK parent of both the opening transaction and the
        // ledger entry. Entities link by raw UUID rather than ORM relations, so
        // flush it explicitly before inserting its children.
        await this.walletRepo.save(wallet, em);
        await em.flush();

        let openingTxId: string | null = null;

        if (!money.isZero()) {
          const openingTx = WagerTransaction.create({
            id: this.idGenerator.generate(),
            providerId: 'system',
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `system:opening:${walletId}`,
            payloadHash: canonicalHash({
              kind: WagerTransactionKind.Opening,
              walletId,
              playerId: input.playerId,
              money: input.initialBalance,
            }),
            walletId,
            playerId: input.playerId,
            roundId: 'opening',
            gameId: 'system',
            kind: WagerTransactionKind.Opening,
            money: input.initialBalance,
          });
          openingTx.markProcessed(undefined, now);
          openingTxId = openingTx.id;

          // Wallet.open() already sets the initial balance. The ledger entry
          // records that credit from zero; calling wallet.credit() here would
          // apply the same money twice and break the balance/ledger invariant.
          const creditResult = {
            direction: LedgerDirection.Credit,
            money,
            balanceBefore: Money.zero(money.currency),
            balanceAfter: money,
          };

          const ledgerEntry = WalletLedgerEntry.create({
            id: this.idGenerator.generate(),
            walletId,
            transactionId: openingTx.id,
            direction: creditResult.direction,
            money: creditResult.money.toJSON(),
            balanceBefore: creditResult.balanceBefore.toJSON(),
            balanceAfter: creditResult.balanceAfter.toJSON(),
            createdAt: now,
          });

          await this.txRepo.save(openingTx, em);
          await em.flush();
          await this.ledgerRepo.save(ledgerEntry, em);
          await em.flush();

          await this.enqueueOutboxEvent(
            {
              aggregateId: openingTx.id,
              eventType: 'WagerTransactionProcessed',
              payload: WagerTransactionProcessed.from({
                transactionId: openingTx.id,
                walletId,
                playerId: input.playerId,
                providerId: 'system',
                externalTransactionId: `opening:${walletId}`,
                kind: WagerTransactionKind.Opening,
                money: input.initialBalance,
                idempotentReplay: false,
                ctx: { correlationId: walletId, occurredAt: now },
              }).toJSON(),
              occurredAt: now,
            },
            em,
          );

          await this.enqueueBalanceChanged(
            walletId,
            openingTx.id,
            creditResult,
            wallet.version,
            now,
            em,
          );
        }

        this.logger.info('Wallet opened', {
          walletId,
          playerId: input.playerId,
          currency: input.currency,
          openingTransactionId: openingTxId,
        });

        return {
          walletId,
          playerId: input.playerId,
          balance: wallet.toSnapshot(),
          version: wallet.version,
          openingTransactionId: openingTxId,
        };
      });
    } catch (error) {
      // A concurrent insert can still lose the unique-index race (e.g. a custom
      // wallet id). Map the driver error to the same domain contract.
      if (isUniqueViolation(error)) {
        throw new WalletAlreadyExistsError(input.playerId, input.currency);
      }
      throw error;
    }
  }

  private async enqueueBalanceChanged(
    walletId: string,
    transactionId: string,
    result: { direction: LedgerDirection; money: Money; balanceBefore: Money; balanceAfter: Money },
    walletVersion: number,
    occurredAt: Date,
    em: EntityManagerForWallet,
  ): Promise<void> {
    const event = WalletBalanceChanged.from(
      walletId,
      transactionId,
      {
        direction: result.direction,
        money: result.money.toJSON(),
        balanceBefore: result.balanceBefore.toJSON(),
        balanceAfter: result.balanceAfter.toJSON(),
      },
      walletVersion,
      { correlationId: walletId, occurredAt },
    );

    await this.outboxRepo.save(
      OutboxMessage.enqueue({
        aggregateId: walletId,
        eventType: event.eventType,
        payload: event.toJSON(),
        occurredAt,
      }),
      em,
    );
  }

  private async enqueueOutboxEvent(
    props: { aggregateId: string; eventType: string; payload: Record<string, unknown>; occurredAt: Date },
    em: EntityManagerForWallet,
  ): Promise<void> {
    await this.outboxRepo.save(
      OutboxMessage.enqueue({
        aggregateId: props.aggregateId,
        eventType: props.eventType,
        payload: props.payload,
        occurredAt: props.occurredAt,
      }),
      em,
    );
  }
}
