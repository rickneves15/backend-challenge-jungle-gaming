const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/** Exponential backoff with jitter-free doubling, capped at 60s. */
export function nextBackoffMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 0), 10);
  return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS);
}

