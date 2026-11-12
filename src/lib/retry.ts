/**
 * Retrying reads that must outlast a blip. A request a person may still answer
 * must not be abandoned because one read failed: network errors, 5xx and 429
 * are retried with capped backoff (429 and 503 honour Retry-After) until a
 * deadline, and only then reported as lost touch. A 2xx reply the CLI cannot
 * read is retried the same way, for ten seconds at most. An abort signal stops the
 * attempt in flight and the wait between attempts.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { MalformedReply, TapApiError } from "./rest.js";

const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60_000;
/** A reply TAP sent but the CLI could not read rarely heals by waiting, so it is retried for this long at most. */
const MALFORMED_RETRY_MS = 10_000;

/** fetch rejects a refused or dropped connection with a TypeError that carries the socket error as `cause`. */
export function isTransient(err: unknown): boolean {
  if (err instanceof MalformedReply) return true;
  if (err instanceof TapApiError) return err.status === 429 || err.status >= 500;
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || (err instanceof TypeError && err.cause !== undefined);
}

export function describeFailure(err: unknown): string {
  if (err instanceof MalformedReply) return err.message;
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
  /** Epoch ms. No attempt starts after this. A deadline that is not a number allows no retries. */
  until: number;
  /** Aborting rejects with the signal's reason, whether an attempt is in flight or the next one is waiting. */
  signal?: AbortSignal;
}

function msLeft(until: number): number {
  return Number.isFinite(until) ? until - Date.now() : 0;
}

/** How long to wait before trying again, or throw: the abort reason, a failure not worth retrying, or LostTouch past the deadline. */
function nextDelay(err: unknown, attempt: number, opts: RetryOptions, started: number): number {
  opts.signal?.throwIfAborted();
  if (!isTransient(err)) throw err;
  const left = msLeft(err instanceof MalformedReply ? Math.min(opts.until, started + MALFORMED_RETRY_MS) : opts.until);
  if (left <= 0) throw new LostTouch(describeFailure(err));
  return Math.min(left, retryDelayMs(err, attempt));
}

export async function retrying<T>(op: (signal?: AbortSignal) => Promise<T>, opts: RetryOptions): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      const value = await op(opts.signal);
      if (attempt > 0) opts.onRecover?.();
      return value;
    } catch (err) {
      const delay = nextDelay(err, attempt, opts, started);
      opts.onRetry?.(describeFailure(err), delay);
      await sleep(delay, undefined, { signal: opts.signal });
    }
  }
}
