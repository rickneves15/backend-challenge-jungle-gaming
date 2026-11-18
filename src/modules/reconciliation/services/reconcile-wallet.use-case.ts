import { Inject, Injectable, Optional } from '@nestjs/common';
import { IsolationLevel } from '@mikro-orm/core';

import type {
  WalletRepository,
  LedgerEntryRepository,
  UnitOfWork,
  Logger,
} from '@/shared/kernel/ports';
import {
  LEDGER_ENTRY_REPOSITORY,
  LOGGER,
  UNIT_OF_WORK,
  WALLET_REPOSITORY,
} from '@/shared/kernel/ports/tokens';
import { Money } from '@/shared/domain/value-objects/money';
import { WalletNotFoundError } from '@/shared/domain/errors/domain-error';
import { MetricsService } from '@/shared/infrastructure/observability/metrics.service';

export interface ReconcileWalletOutput {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledgerRepo: LedgerEntryRepository,
    @Inject(LOGGER) private readonly logger: Logger,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletOutput> {
    // REPEATABLE READ gives the wallet balance and every paginated ledger read
    // one snapshot. Without it a wager committing mid-page can produce a false
    // mismatch (or a false match when the balance and new entry offset).
    return this.uow.transactional(
      async (em) => {
        const wallet = await this.walletRepo.findById(walletId, em);
        if (!wallet) {
          throw new WalletNotFoundError(walletId);
        }

        const stored = wallet.balance;
        let calculated = Money.zero(wallet.currency);
        let checkedEntries = 0;

        let cursor: string | undefined;
        do {
          const { entries, nextCursor } = await this.ledgerRepo.findByWallet(
            walletId,
            cursor,
            100,
            em,
          );
          checkedEntries += entries.length;
          for (const entry of entries) {
            const money = entry.money;
            calculated =
              entry.direction === 'CREDIT' ? calculated.add(money) : calculated.subtract(money);
          }
          cursor = nextCursor;
        } while (cursor);

        const difference = calculated.subtract(stored);
        const consistent = calculated.equals(stored);

        if (!consistent) {
          // Log identifiers only: balances are financial payloads and must not be
          // written to logs. The mismatch is counted as a metric instead.
          this.metrics?.inc('reconciliation_mismatches', { walletId });
          this.logger.error('Reconciliation inconsistent', { walletId, checkedEntries });
        } else {
          this.logger.info('Reconciliation consistent', { walletId, checkedEntries });
        }

        return {
          walletId,
          storedBalance: { amount: stored.amount, currency: stored.currency },
          calculatedBalance: { amount: calculated.amount, currency: calculated.currency },
          difference: { amount: difference.amount, currency: difference.currency },
          consistent,
          checkedEntries,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ },
    );
  }
}
