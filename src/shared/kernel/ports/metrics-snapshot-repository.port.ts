export interface StoredMetricSnapshot {
  id: string;
  instanceId: string;
  recordedAt: Date;
  payload: Record<string, unknown>;
}

/** Durable export surface for process-local metrics. */
export interface MetricsSnapshotRepository {
  append(snapshot: StoredMetricSnapshot): Promise<void>;
  latest(limit: number): Promise<StoredMetricSnapshot[]>;
}
