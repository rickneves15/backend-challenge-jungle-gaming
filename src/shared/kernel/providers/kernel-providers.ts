import { Injectable, LoggerService } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

/** Identifiers that must be present on every structured log line when known. */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const logContext = new AsyncLocalStorage<LogFields>();

/** Runs `fn` with extra log identifiers available to every nested log call. */
export function runWithLogContext<T>(fields: LogFields, fn: () => Promise<T> | T): Promise<T> | T {
  return logContext.run({ ...logContext.getStore(), ...fields }, fn);
}

/** Adds identifiers to the current async context (e.g. after a transaction id is known). */
export function setLogContext(fields: LogFields): void {
  logContext.enterWith({ ...logContext.getStore(), ...fields });
}

@Injectable()
export class SystemClock {
  now(): Date {
    return new Date();
  }
}

@Injectable()
export class UuidIdGenerator {
  generate(): string {
    return crypto.randomUUID();
  }
}

/**
 * Real JSON logger (pino) implementing both the domain Logger port and Nest's
 * LoggerService, so application and framework logs share one structured shape.
 *
 * Context is propagated with AsyncLocalStorage instead of being passed to every
 * method call. Only identifiers are logged — never full money/payload objects.
 */
@Injectable()
export class PinoLogger implements LoggerService {
  private readonly logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    formatters: { level: (label) => ({ level: label }) },
    base: undefined,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  });

  private write(level: 'debug' | 'info' | 'warn' | 'error', message: string, ctx?: Record<string, unknown>): void {
    const fields: Record<string, unknown> = { ...(logContext.getStore() ?? {}) };
    const sanitized = this.sanitize(ctx);
    const record: Record<string, unknown> = { ...fields, ...sanitized };
    // Remove undefined values so JSON lines stay compact and stable.
    for (const key of Object.keys(record)) {
      if (record[key] === undefined) delete record[key];
    }
    this.logger[level](record, message);
  }

  private sanitize(ctx?: Record<string, unknown>): Record<string, unknown> {
    if (!ctx) return {};
    const out: Record<string, unknown> = {};
    const safeKeys = [
      'correlationId',
      'messageId',
      'transactionId',
      'walletId',
      'providerId',
      'outboxId',
      'eventType',
      'kind',
      'status',
      'failureCode',
      'attempt',
      'idempotentReplay',
      'waitedMs',
      'durationMs',
      'error',
      'processed',
      'rejected',
      'stillPending',
      'total',
      'port',
    ];
    for (const key of safeKeys) {
      if (ctx[key] !== undefined) out[key] = ctx[key];
    }
    return out;
  }

  info(message: string, ctx?: Record<string, unknown>): void {
    this.write('info', message, ctx);
  }

  warn(message: string, ctx?: Record<string, unknown>): void {
    this.write('warn', message, ctx);
  }

  error(message: string, ctx?: Record<string, unknown>): void {
    this.write('error', message, ctx);
  }

  debug(message: string, ctx?: Record<string, unknown>): void {
    this.write('debug', message, ctx);
  }

  // ---- Nest LoggerService -------------------------------------------------

  log(message: string, context?: string): void {
    this.write('info', message, context ? { eventType: context } : undefined);
  }

  verbose(message: string, context?: string): void {
    this.write('debug', message, context ? { eventType: context } : undefined);
  }

  fatal(message: string, context?: string): void {
    this.write('error', message, context ? { eventType: context } : undefined);
  }
}
