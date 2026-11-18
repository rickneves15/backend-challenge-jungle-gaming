import { Inject, Injectable, Optional } from '@nestjs/common';

import type {
  WagerTransactionRepository,
  Clock,
  Logger,
} from '@/shared/kernel/ports';
import {
  CLOCK,
  LOGGER,
  WAGER_TRANSACTION_REPOSITORY,
} from '@/shared/kernel/ports/tokens';
import { WagerTransactionStatus } from '@/shared/domain/rules/wager-rules';
import { SubmitWagerTransactionUseCase } from '@/modules/wagering/services/submit-wager-transaction.use-case';
import { MetricsService } from '@/shared/infrastructure/observability/metrics.service';

export interface ProcessPendingReferenceResult {
  processed: number;
  rejected: number;
  stillPending: number;
}

@Injectable()
export class ProcessPendingReferencesUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly txRepo: WagerTransactionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly submitUseCase: SubmitWagerTransactionUseCase,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Reprocesses only rows whose exponential-backoff deadline has elapsed.
   * `nowOverride` exists for deterministic tests: passing a future instant
   * makes freshly scheduled rows immediately eligible.
   */
  async execute(nowOverride?: Date): Promise<ProcessPendingReferenceResult> {
    const now = nowOverride ?? this.clock.now();
    const pending = await this.txRepo.findPendingReferenceOlderThan(now, 100);
    let processed = 0;
    let rejected = 0;
    let stillPending = 0;

    for (const tx of pending) {
      try {
        // Reusing the same idempotency key makes the submit use case resume
        // this exact transaction instead of creating a duplicate one.
        const result = await this.submitUseCase.execute({
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          idempotencyKey: tx.idempotencyKey,
          payloadHash: tx.payloadHash,
          playerId: tx.playerId,
          walletId: tx.walletId,
          roundId: tx.roundId,
          gameId: tx.gameId,
          kind: tx.kind,
          money: { amount: tx.moneyAmount, currency: tx.moneyCurrency },
          referenceExternalTransactionId: tx.referenceExternalTransactionId,
        });

        if (result.status === WagerTransactionStatus.Rejected) {
          rejected += 1;
        } else if (result.status === WagerTransactionStatus.PendingReference) {
          stillPending += 1;
        } else {
          processed += 1;
        }
      } catch (err) {
        this.logger.debug('Reference still pending', {
          transactionId: tx.id,
          error: String(err),
        });
        stillPending += 1;
      }
    }

    this.metrics?.inc('retries', { reason: 'pending_reference_sweep' });
    this.logger.info('Pending reference reprocessing completed', {
      processed,
      rejected,
      stillPending,
      total: pending.length,
    });

    return { processed, rejected, stillPending };
  }
}
