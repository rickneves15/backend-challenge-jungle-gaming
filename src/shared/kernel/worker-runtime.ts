import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const WORKER_ROLES = [
  'sqs-consumer',
  'outbox',
  'pending-references',
  'metrics-snapshot',
] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

const ALL_ROLES: ReadonlySet<WorkerRole> = new Set(WORKER_ROLES);

/**
 * Explicit runtime topology. Background loops are opt-in so an API-only
 * replica does not silently also consume SQS, publish the outbox and sweep
 * pending references. `WORKER_ROLES=all` enables every loop.
 */
@Injectable()
export class WorkerRuntime {
  private readonly enabled: ReadonlySet<WorkerRole>;

  constructor(config: ConfigService) {
    const raw = config.get<string>('WORKER_ROLES', '')?.trim() ?? '';
    if (raw.toLowerCase() === 'all' || raw === '*') {
      this.enabled = ALL_ROLES;
      return;
    }

    const roles = raw
      .split(',')
      .map((role) => role.trim() as WorkerRole)
      .filter((role) => WORKER_ROLES.includes(role));
    this.enabled = new Set(roles);
  }

  isEnabled(role: WorkerRole): boolean {
    return this.enabled.has(role);
  }
}
