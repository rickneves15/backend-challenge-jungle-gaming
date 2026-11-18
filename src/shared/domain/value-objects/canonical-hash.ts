import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys are sorted at EVERY nesting
 * level. Do not use `JSON.stringify(value, Object.keys(value).sort())`: the
 * replacer array is applied recursively and drops nested keys such as
 * `money.amount`, making different amounts hash to the same value.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 of the canonical business payload. Never includes transport metadata. */
export function canonicalHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}
