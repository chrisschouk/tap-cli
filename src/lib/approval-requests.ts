/**
 * Approval requests: the CLI asks a signed-in person to approve pitches, and
 * waits for their answer. The key can create, read and withdraw a request.
 * Only a person signed in to TAP in a browser can answer one, so nothing here
 * approves or sends. Shapes copied from total-audio-platform
 * apps/tap/lib/approval-requests/model.ts (`publicRequest`).
 */

import { restRequest, TapApiError } from "./rest.js";
import { retrying, type RetryHooks } from "./retry.js";

/** The server takes at most 50 pitches per request and holds a read (or a refused cancel) open for at most 25 seconds. */
export const MAX_REQUEST_PITCHES = 50;
const MAX_WAIT_SECONDS = 25;
const HELD_TIMEOUT_MS = (MAX_WAIT_SECONDS + 20) * 1000;
/** The create route answers at once; past this the CLI stops waiting for it. */
const CREATE_TIMEOUT_MS = 15_000;
/** How long a withdrawal keeps trying before saying the request is still open. */
const WITHDRAW_RETRY_MS = 30_000;

/** 0 when at least one pitch was approved (or the request waits by choice), 1 otherwise, 130 when the person stopped. */
export const EXIT_CODE = { approved: 0, notApproved: 1, interrupted: 130 } as const;
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "partial"
  | "declined"
  | "interrupted"
  | "expired"
  | "cancelled"
  | "superseded";

export interface ApprovalResult {
  approved: string[];
  skipped: Array<{ id: string; reason: string }>;
}

export interface ApprovalRequest {
  id: string;
  code: string;
  status: ApprovalStatus;
  url: string;
  origin: string;
  item_count: number;
  items: Array<{ pitch_id: string; to: string | null; subject: string | null }>;
  result: ApprovalResult | null;
  created_at: string;
  expires_at: string;
  answered_at: string | null;
  answered_via: string | null;
}

export type CreatedRequest = Pick<ApprovalRequest, "id" | "code" | "url" | "expires_at" | "status">;

/** Why the server refused to ask about a pitch (POST 422). */
export interface RejectedPitch {
  id: string;
  reason: "not_found" | "not_pending" | string;
}

export class ApprovalRejected extends Error {
  constructor(public readonly rejected: RejectedPitch[]) {
    super("Some pitches cannot be approved now");
    this.name = "ApprovalRejected";
  }
}

export async function createApprovalRequest(pitchIds: string[], signal?: AbortSignal): Promise<CreatedRequest> {
  try {
    return await restRequest<CreatedRequest>("/api/v1/approval-requests", {
      method: "POST",
      body: { pitch_ids: pitchIds, origin: "cli" },
      timeoutMs: CREATE_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    const rejected = (err instanceof TapApiError && err.status === 422 && (err.body as { rejected?: RejectedPitch[] })?.rejected) || null;
    if (rejected) throw new ApprovalRejected(rejected);
    throw err;
  }
}

/** Connection refused or host unknown: the create never reached TAP. */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * A failed create that TAP may still have carried out: it timed out, the
 * person quit while it was in flight, the connection dropped, or TAP answered
 * 5xx. There is no id to show, so the person has to look in TAP. A 4xx
 * refusal, or a connection that never opened, created nothing.
 */
export function createMayHaveLanded(err: unknown): boolean {
  if (err instanceof TapApiError) return err.status >= 500;
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  return !(cause && NEVER_SENT.has(cause)) && err instanceof Error && (err instanceof TypeError || err.name === "TimeoutError" || err.name === "AbortError");
}

export function readApprovalRequest(id: string, waitSeconds = 0, signal?: AbortSignal): Promise<ApprovalRequest> {
  return restRequest<ApprovalRequest>(`/api/v1/approval-requests/${encodeURIComponent(id)}`, {
    query: { wait: Math.min(waitSeconds, MAX_WAIT_SECONDS) },
    timeoutMs: HELD_TIMEOUT_MS,
    signal,
  });
}

/**
 * Withdraw a request. The server refuses with 409 once a person has started
 * answering or the request is final; it holds that 409 for up to 25 seconds
 * while the answer finishes, then returns the request as it stands. Both
 * outcomes come back here as the request.
 */
export async function cancelApprovalRequest(id: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  try {
    return await restRequest<ApprovalRequest>(`/api/v1/approval-requests/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      timeoutMs: HELD_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    const request = err instanceof TapApiError && err.status === 409 && (err.body as { request?: ApprovalRequest })?.request;
    if (request) return request;
    throw err;
  }
}

export function isFinal(request: Pick<ApprovalRequest, "status">): boolean {
  return request.status !== "pending";
}

type Deadline = Pick<CreatedRequest, "id" | "expires_at">;

export interface Reading extends RetryHooks {
  /** Aborting rejects with the signal's reason, mid-read or between retries. */
  signal?: AbortSignal;
}

/**
 * Long-poll until the request leaves pending. Transient failures are retried
 * until the request expires; past that, LostTouch. The server closes a request
 * as expired once its deadline passes, so this ends on its own.
 */
export async function waitForAnswer(request: Deadline, opts: Reading = {}): Promise<ApprovalRequest> {
  const until = Date.parse(request.expires_at);
  for (;;) {
    const read = await retrying((signal) => readApprovalRequest(request.id, MAX_WAIT_SECONDS, signal), { ...opts, until });
    if (isFinal(read)) return read;
  }
}

/** Read once, retrying transient failures until the request expires. */
export function readWithRetry(request: Deadline, opts: Reading = {}): Promise<ApprovalRequest> {
  return retrying((signal) => readApprovalRequest(request.id, 0, signal), { ...opts, until: Date.parse(request.expires_at) });
}

/** Withdraw, retrying transient failures for a short while. LostTouch means the request is still open. */
export function withdrawApprovalRequest(request: Deadline, opts: Reading = {}): Promise<ApprovalRequest> {
  const until = Math.min(Date.parse(request.expires_at), Date.now() + WITHDRAW_RETRY_MS);
  return retrying((signal) => cancelApprovalRequest(request.id, signal), { ...opts, until });
}
