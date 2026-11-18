import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import type {
  MetricsSnapshotRepository,
  StoredMetricSnapshot,
} from '@/shared/kernel/ports/metrics-snapshot-repository.port';

@Injectable()
export class MikroOrmMetricsSnapshotRepository implements MetricsSnapshotRepository {
  constructor(private readonly em: EntityManager<PostgreSqlDriver>) {}

  async append(snapshot: StoredMetricSnapshot): Promise<void> {
    await this.em.getConnection().execute(
      `INSERT INTO metric_snapshots (id, instance_id, recorded_at, payload)
       VALUES (?, ?, ?, ?)`,
      [snapshot.id, snapshot.instanceId, snapshot.recordedAt, JSON.stringify(snapshot.payload)],
      'run',
    );
  }

  async latest(limit: number): Promise<StoredMetricSnapshot[]> {
    const rows = await this.em.getConnection().execute(
      `SELECT id, instance_id, recorded_at, payload
         FROM metric_snapshots
        ORDER BY recorded_at DESC
        LIMIT ?`,
      [limit],
      'all',
    );

    return rows.map((row: any) => ({
      id: String(row.id),
      instanceId: String(row.instance_id),
      recordedAt: row.recorded_at instanceof Date ? row.recorded_at : new Date(row.recorded_at),
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    }));
  }
}
