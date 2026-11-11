/**
 * Pitches that still need the artist in TAP: drafts, drafts waiting for
 * approval, and approved pitches TAP has not sent yet. Approving and sending
 * are human-only, so the CLI only reads this list and links to the dashboard.
 */

import { restRequest } from "./rest.js";

export type PendingState = "draft" | "pending_approval" | "approved";

export const PENDING_STATE_LABEL: Record<PendingState, string> = {
  draft: "draft",
  pending_approval: "waiting for approval",
  approved: "approved, not sent yet",
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
  send_status: string;
}

interface OutreachQueueRow {
  id: string;
  state: string | null;
  send_status: string | null;
  scheduled_for: string | null;
}

function pendingState(row: OutreachQueueRow): PendingState | null {
  if (row.send_status === "sent") return null;
  const state = row.state ?? "draft";
  return state in PENDING_STATE_LABEL ? (state as PendingState) : null;
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

export async function fetchPendingPitches(campaignId: string): Promise<PendingPitch[]> {
  const id = encodeURIComponent(campaignId);
  const [{ pitches }, { items }] = await Promise.all([
    restRequest<{ pitches: CampaignPitchRow[] }>(`/api/v1/campaigns/${id}/pitches`),
    restRequest<{ items: OutreachQueueRow[] }>("/api/v1/outreach/queue", {
      query: { campaign_id: campaignId, source: "pitch_draft", limit: 200 },
    }),
  ]);
  return toPendingPitches(pitches, items);
}
