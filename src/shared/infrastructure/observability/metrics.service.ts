import { Injectable } from '@nestjs/common';

export type MetricName =
  | 'transactions_by_status'
  | 'duplicates_detected'
  | 'retries'
  | 'dlq_messages'
  | 'lock_conflicts'
  | 'outbox_lag_ms'
  | 'processing_latency_ms'
  | 'reconciliation_mismatches';

type Sample = { count: number; sum: number; min: number; max: number; values: number[] };

/**
 * Minimal in-process metrics registry. It is deliberately not used for
 * correctness or idempotency — those live in PostgreSQL. Scrape /api/metrics.
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly samples = new Map<string, Sample>();
  private readonly gauges = new Map<string, number>();

  private static key(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const suffix = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`)
      .join(',');
    return `${name}{${suffix}}`;
  }

  inc(name: MetricName, labels?: Record<string, string>, value = 1): void {
    const key = MetricsService.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: MetricName, value: number, labels?: Record<string, string>): void {
    const key = MetricsService.key(name, labels);
    const sample = this.samples.get(key) ?? { count: 0, sum: 0, min: value, max: value, values: [] };
    sample.count += 1;
    sample.sum += value;
    sample.min = Math.min(sample.min, value);
    sample.max = Math.max(sample.max, value);
    // Bound memory: percentiles only need a bounded recent window.
    sample.values.push(value);
    if (sample.values.length > 1000) sample.values.shift();
    this.samples.set(key, sample);
  }

  set(name: MetricName, value: number, labels?: Record<string, string>): void {
    this.gauges.set(MetricsService.key(name, labels), value);
  }

  snapshot(): Record<string, unknown> {
    const histogram: Record<string, unknown> = {};
    for (const [key, sample] of this.samples) {
      const sorted = [...sample.values].sort((a, b) => a - b);
      const percentile = (p: number) =>
        sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
      histogram[key] = {
        count: sample.count,
        sum: sample.sum,
        min: sample.min,
        max: sample.max,
        p50: percentile(50),
        p95: percentile(95),
        p99: percentile(99),
      };
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: histogram,
    };
  }
}
