import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  Clock,
  IdGenerator,
  MetricsSnapshotRepository,
  StoredMetricSnapshot,
} from '@/shared/kernel/ports';
import {
  CLOCK,
  ID_GENERATOR,
  METRICS_SNAPSHOT_REPOSITORY,
} from '@/shared/kernel/ports/tokens';
import { MetricsService } from './metrics.service';

/**
 * Durable export for the process-local registry. The HTTP endpoint keeps the
 * current process view; snapshots make counters comparable across restarts and
 * across replicas.
 */
@Injectable()
export class MetricsSnapshotService {
  private readonly instanceId: string;

  constructor(
    @Inject(METRICS_SNAPSHOT_REPOSITORY)
    private readonly repository: MetricsSnapshotRepository,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.instanceId = config.get<string>(
      'METRICS_INSTANCE_ID',
      process.env.HOSTNAME ?? 'local',
    );
  }

  async flush(): Promise<StoredMetricSnapshot> {
    const snapshot: StoredMetricSnapshot = {
      id: this.idGenerator.generate(),
      instanceId: this.instanceId,
      recordedAt: this.clock.now(),
      payload: this.metrics.snapshot(),
    };
    await this.repository.append(snapshot);
    return snapshot;
  }

  latest(limit = 20): Promise<StoredMetricSnapshot[]> {
    return this.repository.latest(Math.min(Math.max(limit, 1), 100));
  }
}
