/**
 * Approval requests: the CLI asks a signed-in person to approve pitches, and
 * waits for their answer. The key can create, read and withdraw a request.
 * Only a person signed in to TAP in a browser can answer one, so nothing here
 * approves or sends. Shapes copied from total-audio-platform
 * apps/tap/lib/approval-requests/model.ts (`publicRequest`).
 */

import { restRequest, TapApiError } from "./rest.js";

/** The server takes at most 50 pitches per request and holds a read open for at most 25 seconds. */
export const MAX_REQUEST_PITCHES = 50;
const MAX_WAIT_SECONDS = 25;

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

export async function createApprovalRequest(pitchIds: string[]): Promise<CreatedRequest> {
  try {
    return await restRequest<CreatedRequest>("/api/v1/approval-requests", {
      method: "POST",
      body: { pitch_ids: pitchIds, origin: "cli" },
    });
  } catch (err) {
    const rejected = (err instanceof TapApiError && err.status === 422 && (err.body as { rejected?: RejectedPitch[] })?.rejected) || null;
    if (rejected) throw new ApprovalRejected(rejected);
    throw err;
  }
}

export function readApprovalRequest(id: string, waitSeconds = 0): Promise<ApprovalRequest> {
  return restRequest<ApprovalRequest>(`/api/v1/approval-requests/${encodeURIComponent(id)}`, { query: { wait: Math.min(waitSeconds, MAX_WAIT_SECONDS) } });
}

/**
 * Withdraw a request. The server refuses with 409 once a person has started
 * answering or the request is final, and returns the request as it stands;
 * both outcomes come back here as the request.
 */
export async function cancelApprovalRequest(id: string): Promise<ApprovalRequest> {
  try {
    return await restRequest<ApprovalRequest>(`/api/v1/approval-requests/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  } catch (err) {
    const request = err instanceof TapApiError && err.status === 409 && (err.body as { request?: ApprovalRequest })?.request;
    if (request) return request;
    throw err;
  }
}

export function isFinal(request: Pick<ApprovalRequest, "status">): boolean {
  return request.status !== "pending";
}

/**
 * Long-poll until the request leaves pending, or `stopped()` turns true (the
 * last read is returned then). The server closes a request as expired once
 * its deadline passes, so this ends on its own.
 */
export async function waitForAnswer(id: string, stopped: () => boolean = () => false): Promise<ApprovalRequest> {
  for (;;) {
    const request = await readApprovalRequest(id, MAX_WAIT_SECONDS);
    if (isFinal(request) || stopped()) return request;
  }
}

/** 1 when the request is final and nothing approved; 0 while it waits or once anything approved. */
export function exitCodeFor(request: Pick<ApprovalRequest, "status" | "result">): number {
  if (!isFinal(request)) return 0;
  return (request.result?.approved.length ?? 0) > 0 ? 0 : 1;
}
