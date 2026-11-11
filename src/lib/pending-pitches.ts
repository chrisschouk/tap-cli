/**
 * Pitches that still need the artist in TAP: drafts, drafts waiting for
 * approval, approved pitches TAP has not sent yet, and approved pitches whose
 * send failed or is held for payment. Approving and sending are human-only,
 * so the CLI only reads this list and links to the dashboard.
 */

import { fetchAllPages, restRequest } from "./rest.js";

/** Approval states (`campaign_pitch_drafts.approval_state`) that still need the artist. */
const WAITING_STATES = ["draft", "pending_approval", "approved"] as const;

export type PendingState =
  | "draft"
  | "pending_approval"
  | "approved"
  | "send_failed"
  | "held_for_payment";

export const PENDING_STATE_LABEL: Record<PendingState, string> = {
  draft: "draft",
  pending_approval: "waiting for approval",
  approved: "approved, not sent yet",
  send_failed: "approved, send failed",
  held_for_payment: "approved, held for payment",
};

export interface PendingPitch {
  id: string;
  subject: string;
  state: PendingState;
  scheduledFor: string | null;
}

interface CampaignPitchRow {
  id: string;
  title: string | null;
  subject: string | null;
}

export interface OutreachQueueRow {
  id: string;
  state: string | null;
  send_status: string | null;
  scheduled_for: string | null;
}

/** An approved pitch's send_status says whether TAP is still on it. */
const APPROVED_BY_SEND_STATUS: Record<string, PendingState> = {
  failed: "send_failed",
  held_for_payment: "held_for_payment",
};

function pendingState(row: OutreachQueueRow): PendingState | null {
  if (row.send_status === "sent") return null;
  if (row.state === "approved") return APPROVED_BY_SEND_STATUS[row.send_status ?? ""] ?? "approved";
  if (row.state === "draft" || row.state === "pending_approval") return row.state;
  return null;
}

export function toPendingPitches(
  pitches: CampaignPitchRow[],
  queue: OutreachQueueRow[],
): PendingPitch[] {
  const byId = new Map(pitches.map((p) => [p.id, p]));
  const pending: PendingPitch[] = [];
  for (const row of queue) {
    const state = pendingState(row);
    if (!state) continue;
    const pitch = byId.get(row.id);
    pending.push({
      id: row.id,
      subject: pitch?.subject || pitch?.title || "No subject",
      state,
      scheduledFor: row.scheduled_for,
    });
  }
  return pending;
}

/**
 * The queue is sorted by `updated_at desc` and holds sent rows too, so one
 * page can be all sent pitches. Ask for each waiting state and read every page.
 */
export async function fetchPendingPitches(campaignId: string): Promise<PendingPitch[]> {
  const id = encodeURIComponent(campaignId);
  const [{ pitches }, ...byState] = await Promise.all([
    restRequest<{ pitches: CampaignPitchRow[] }>(`/api/v1/campaigns/${id}/pitches`),
    ...WAITING_STATES.map((state) =>
      fetchAllPages<OutreachQueueRow>("/api/v1/outreach/queue", "items", {
        campaign_id: campaignId,
        source: "pitch_draft",
        state,
      }),
    ),
  ]);
  return toPendingPitches(pitches, byState.flat());
}
