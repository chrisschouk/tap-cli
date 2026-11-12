/**
 * Approval requests: the CLI asks a signed-in person to approve pitches, and
 * waits for their answer. The key can create, read and withdraw a request.
 * Only a person signed in to TAP in a browser can answer one, so nothing here
 * approves or sends. Shapes copied from total-audio-platform
 * apps/tap/lib/approval-requests/model.ts (`publicRequest`).
 *
 * Every reply is parsed here, once. Past this module a request is the branded
 * `ApprovalRequest` or `CreatedRequest`; anything TAP sends that does not fit
 * is a `MalformedReply`, never a request with missing fields.
 */

import { MalformedReply, restRequest, TapApiError } from "./rest.js";
import { retrying, type RetryHooks } from "./retry.js";

/** The server takes at most 50 pitches per request and holds a read (or a refused cancel) open for at most 25 seconds. */
export const MAX_REQUEST_PITCHES = 50;
const MAX_WAIT_SECONDS = 25;
const HELD_TIMEOUT_MS = (MAX_WAIT_SECONDS + 20) * 1000;
/** The create route answers at once; past this the CLI stops waiting for it. */
const CREATE_TIMEOUT_MS = 15_000;
/** How long a withdrawal, or a first read by id alone, keeps trying before giving up. */
const SHORT_RETRY_MS = 30_000;

/** 0 when at least one pitch was approved (or the request waits by choice), 1 otherwise, 130 when the person stopped. */
export const EXIT_CODE = { approved: 0, notApproved: 1, interrupted: 130 } as const;

const FINAL_STATUSES = ["approved", "partial", "declined", "interrupted", "expired", "cancelled", "superseded"] as const;
export type FinalStatus = (typeof FINAL_STATUSES)[number];
export type ApprovalStatus = "pending" | FinalStatus;
const FINAL = new Set<string>(FINAL_STATUSES);

export interface ApprovalResult {
  approved: string[];
  skipped: Array<{ id: string; reason: string }>;
}

declare const parsed: unique symbol;
/** Only `parseApprovalRequest` makes one, so every field below holds. */
export interface ApprovalRequest {
  readonly [parsed]: "ApprovalRequest";
  id: string;
  code: string;
  status: ApprovalStatus;
  url: string;
  origin: string;
  item_count: number;
  items: Array<{ pitch_id: string; to: string | null; subject: string | null }>;
  result: ApprovalResult | null;
  created_at: string;
  /** A valid date. */
  expires_at: string;
  answered_at: string | null;
  answered_via: string | null;
}

/** What the CLI needs from the create reply to wait on the request. Only `parseCreated` makes one. */
export interface CreatedRequest {
  readonly [parsed]: "CreatedRequest";
  id: string;
  code: string;
  url: string;
  /** A valid date. */
  expires_at: string;
}

type Check = (value: unknown) => boolean;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText: Check = (v) => typeof v === "string" && v.length > 0;
const isString: Check = (v) => typeof v === "string";
const isDate: Check = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const orNull = (check: Check): Check => (v) => v === null || check(v);
const isCount: Check = (v) => Number.isInteger(v) && (v as number) >= 0;
const listOf = (check: Check): Check => (v) => Array.isArray(v) && v.every(check);
const shaped = (shape: Record<string, Check>): Check => (v) => isRecord(v) && fieldAt(v, shape) === null;

/** The first field of `shape` that `value` gets wrong, or null. */
function fieldAt(value: Record<string, unknown>, shape: Record<string, Check>): string | null {
  return Object.keys(shape).find((key) => !shape[key](value[key])) ?? null;
}

const CREATED_SHAPE: Record<string, Check> = { id: isText, code: isText, url: isText, expires_at: isDate };

const REQUEST_SHAPE: Record<string, Check> = {
  ...CREATED_SHAPE,
  origin: isString,
  item_count: isCount,
  items: listOf(shaped({ pitch_id: isText, to: orNull(isString), subject: orNull(isString) })),
  result: orNull(shaped({ approved: listOf(isString), skipped: listOf(shaped({ id: isString, reason: isString })) })),
  created_at: isDate,
  answered_at: orNull(isDate),
  answered_via: orNull(isString),
};

function checked(raw: unknown, shape: Record<string, Check>): Record<string, unknown> {
  if (!isRecord(raw)) throw new MalformedReply("it is not a JSON object");
  const bad = fieldAt(raw, shape);
  if (bad) throw new MalformedReply(`it has no valid ${bad}`);
  return raw;
}

/** A status this CLI does not know is not final: a newer TAP may add one. It reads as a reply not understood, with the status shown. */
function statusOf(raw: Record<string, unknown>): ApprovalStatus {
  const { status } = raw;
  if (status === "pending" || FINAL.has(status as string)) return status as ApprovalStatus;
  if (isText(status)) throw new MalformedReply(`status "${status}" is not one this CLI knows`);
  throw new MalformedReply("it has no valid status");
}

export function parseApprovalRequest(raw: unknown): ApprovalRequest {
  const value = checked(raw, REQUEST_SHAPE);
  return { ...value, status: statusOf(value) } as unknown as ApprovalRequest;
}

export function parseCreated(raw: unknown): CreatedRequest {
  const { id, code, url, expires_at } = checked(raw, CREATED_SHAPE);
  return { id, code, url, expires_at } as unknown as CreatedRequest;
}

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

export async function createApprovalRequest(pitchIds: string[], signal?: AbortSignal, timeoutMs = CREATE_TIMEOUT_MS): Promise<CreatedRequest> {
  try {
    const raw = await restRequest<unknown>("/api/v1/approval-requests", {
      method: "POST",
      body: { pitch_ids: pitchIds, origin: "cli" },
      timeoutMs,
      signal,
    });
    return parseCreated(raw);
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
 * person quit while it was in flight, the connection dropped, TAP answered
 * 5xx, or TAP answered 2xx with a reply the CLI could not read. There is no id
 * to show. A 4xx refusal, or a connection that never opened, created nothing.
 */
export function createMayHaveLanded(err: unknown): boolean {
  if (err instanceof MalformedReply) return true;
  if (err instanceof TapApiError) return err.status >= 500;
  return err instanceof Error && !neverSent(err) && (err instanceof TypeError || err.name === "TimeoutError" || err.name === "AbortError");
}

function neverSent(err: Error): boolean {
  const cause = (err.cause as { code?: string } | undefined)?.code;
  return cause !== undefined && NEVER_SENT.has(cause);
}

export async function readApprovalRequest(id: string, waitSeconds = 0, signal?: AbortSignal): Promise<ApprovalRequest> {
  const raw = await restRequest<unknown>(`/api/v1/approval-requests/${encodeURIComponent(id)}`, {
    query: { wait: Math.min(waitSeconds, MAX_WAIT_SECONDS) },
    timeoutMs: HELD_TIMEOUT_MS,
    signal,
  });
  return parseApprovalRequest(raw);
}

/**
 * Withdraw a request. The server refuses with 409 once a person has started
 * answering or the request is final; it holds that 409 for up to 25 seconds
 * while the answer finishes, then returns the request as it stands. Both
 * outcomes come back here as the request.
 */
export async function cancelApprovalRequest(id: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  let raw: unknown;
  try {
    raw = await restRequest<unknown>(`/api/v1/approval-requests/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      timeoutMs: HELD_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    const refused = err instanceof TapApiError && err.status === 409 && isRecord(err.body) && "request" in err.body;
    if (!refused) throw err;
    raw = (err.body as { request: unknown }).request;
  }
  return parseApprovalRequest(raw);
}

export function isFinal(request: Pick<ApprovalRequest, "status">): request is Pick<ApprovalRequest, "status"> & { status: FinalStatus } {
  return FINAL.has(request.status);
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

/** Read a request known by id alone, retrying transient failures for a short while. */
export function readById(id: string, opts: Reading = {}): Promise<ApprovalRequest> {
  return retrying((signal) => readApprovalRequest(id, 0, signal), { ...opts, until: Date.now() + SHORT_RETRY_MS });
}

/** Withdraw, retrying transient failures for a short while. LostTouch means the request is still open. */
export function withdrawApprovalRequest(request: Deadline, opts: Reading = {}): Promise<ApprovalRequest> {
  const until = Math.min(Date.parse(request.expires_at), Date.now() + SHORT_RETRY_MS);
  return retrying((signal) => cancelApprovalRequest(request.id, signal), { ...opts, until });
}
