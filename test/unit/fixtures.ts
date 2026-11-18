import type { ConfigService } from '@nestjs/config';

import { Wallet } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet.entity.ts';
import { Money } from '@/shared/domain/value-objects/money.ts';

export const WALLET_ID = '11111111-1111-4111-8111-111111111111';
export const TX_ID = '22222222-2222-4222-8222-222222222222';
export const REFERENCE_ID = '33333333-3333-4333-8333-333333333333';
export const LEDGER_ID = '44444444-4444-4444-8444-444444444444';
export const NOW = new Date('2026-01-01T12:00:00.000Z');

export const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as any;

export function makeConfig(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
  } as ConfigService;
}

export function makeMetrics() {
  const calls: Array<{ method: 'inc' | 'set' | 'observe'; name: string; labels?: unknown }> = [];
  return {
    calls,
    inc: (name: string, labels?: unknown) => calls.push({ method: 'inc', name, labels }),
    set: (name: string, _value: number, labels?: unknown) =>
      calls.push({ method: 'set', name, labels }),
    observe: (name: string, _value: number, labels?: unknown) =>
      calls.push({ method: 'observe', name, labels }),
  } as any;
}

export function makeUow() {
  const em = { flush: async () => undefined } as any;
  let isolationLevel: unknown;
  return {
    em,
    get isolationLevel() {
      return isolationLevel;
    },
    transactional: async (fn: (ctx: any) => unknown, options?: { isolationLevel?: unknown }) => {
      isolationLevel = options?.isolationLevel;
      return fn(em);
    },
  } as any;
}

export function makeWallet(): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
}
