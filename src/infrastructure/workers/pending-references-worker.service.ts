import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ProcessPendingReferencesUseCase } from '@/modules/wagering/services/process-pending-references.use-case';
import type { Logger } from '@/shared/kernel/ports';
import { LOGGER } from '@/shared/kernel/ports/tokens';
import { WorkerRuntime } from '@/shared/kernel/worker-runtime';

/**
 * Periodically retries transactions that were submitted before their
 * reference existed. Without this worker those rows would stay in
 * PENDING_REFERENCE forever (unless the provider resubmitted them).
 */
@Injectable()
export class PendingReferencesWorker implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<unknown> | undefined;
  private readonly intervalMs = Number(
    process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? '60000',
  );

  constructor(
    private readonly useCase: ProcessPendingReferencesUseCase,
    private readonly workerRuntime: WorkerRuntime,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    if (!this.workerRuntime.isEnabled('pending-references')) {
      this.logger.info('Pending-reference sweeper disabled by WORKER_ROLES');
      return;
    }

    this.timer = setInterval(() => {
      const task = this.tick().catch((err) =>
        this.logger.error('Pending references sweep failed', { error: String(err) }),
      );
      this.inFlight = task;
    }, this.intervalMs);
    // Do not keep the process alive just for this timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one sweep. Public so tests (and operators) can trigger it on demand. */
  async tick(cutoffOverride?: Date) {
    return this.useCase.execute(cutoffOverride);
  }
}
