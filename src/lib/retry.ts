/**
 * Retrying reads that must outlast a blip. A request a person may still answer
 * must not be abandoned because one read failed: network errors, 5xx and 429
 * are retried with capped backoff (429 and 503 honour Retry-After) until a
 * deadline, and only then reported as lost touch.
 */

import { TapApiError } from "./rest.js";

const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** fetch rejects a refused or dropped connection with a TypeError that carries the socket error as `cause`. */
export function isTransient(err: unknown): boolean {
  if (err instanceof TapApiError) return err.status === 429 || err.status >= 500;
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || (err instanceof TypeError && err.cause !== undefined);
}

function describeFailure(err: unknown): string {
  if (err instanceof TapApiError) return `TAP answered ${err.status}`;
  if (err instanceof Error && err.name === "TimeoutError") return "TAP took too long to answer";
  return "Could not reach TAP";
}

export function retryDelayMs(err: unknown, attempt: number): number {
  const hinted = err instanceof TapApiError ? err.retryAfterSeconds : null;
  if (hinted !== null) return Math.min(MAX_RETRY_AFTER_MS, Math.max(FIRST_DELAY_MS, hinted * 1000));
  return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** attempt);
}

/** TAP could not be reached for long enough that the CLI stopped trying. */
export class LostTouch extends Error {
  constructor(public readonly reason: string) {
    super(`Lost touch with TAP: ${reason}`);
    this.name = "LostTouch";
  }
}

export interface RetryHooks {
  /** A transient failure; the next attempt starts in `delayMs`. */
  onRetry?: (reason: string, delayMs: number) => void;
  /** An attempt succeeded after one or more failures. */
  onRecover?: () => void;
}

export interface RetryOptions extends RetryHooks {
  /** Epoch ms. No attempt starts after this. */
  until: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retrying<T>(op: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await op();
      if (attempt > 0) opts.onRecover?.();
      return value;
    } catch (err) {
      const left = opts.until - Date.now();
      if (!isTransient(err)) throw err;
      if (left <= 0) throw new LostTouch(describeFailure(err));
      const delay = Math.min(left, retryDelayMs(err, attempt));
      opts.onRetry?.(describeFailure(err), delay);
      await sleep(delay);
    }
  }
}
