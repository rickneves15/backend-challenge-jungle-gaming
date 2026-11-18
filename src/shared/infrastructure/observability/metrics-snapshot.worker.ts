import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Logger } from '@/shared/kernel/ports';
import { LOGGER } from '@/shared/kernel/ports/tokens';
import { WorkerRuntime } from '@/shared/kernel/worker-runtime';
import { MetricsSnapshotService } from './metrics-snapshot.service';

/** Periodically persists a metrics snapshot when this replica owns that role. */
@Injectable()
export class MetricsSnapshotWorker implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<unknown> | undefined;
  private readonly intervalMs: number;

  constructor(
    private readonly snapshots: MetricsSnapshotService,
    private readonly config: ConfigService,
    private readonly workerRuntime: WorkerRuntime,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.intervalMs = Number(
      config.get<string>('METRICS_SNAPSHOT_INTERVAL_MS', '60000'),
    );
  }

  onModuleInit(): void {
    if (!this.workerRuntime.isEnabled('metrics-snapshot')) {
      this.logger.info('Metrics snapshot exporter disabled by WORKER_ROLES');
      return;
    }
    this.timer = setInterval(() => {
      const task = this.tick().catch((err) =>
        this.logger.error('Metrics snapshot export failed', { error: String(err) }),
      );
      this.inFlight = task;
    }, this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): Promise<unknown> {
    return this.snapshots.flush();
  }
}
