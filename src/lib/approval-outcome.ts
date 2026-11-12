/**
 * An answered approval request in plain words. Reason labels are the ones the
 * approve page shows (total-audio-platform apps/tap/app/(workspace)/approve/
 * [id]/ApproveClient.tsx `SKIP_LABEL`), so the terminal and the page agree.
 */

import type { ApprovalRequest, ApprovalStatus, RejectedPitch } from "./approval-requests.js";

export const SKIP_LABEL: Record<string, string> = {
  not_selected: "Left out",
  not_found: "No longer available",
  message_changed: "Changed after you opened it",
  already_sending: "Already on its way",
  review_check_failed: "Could not confirm it was you",
  not_reviewed: "Not shown to you",
  interrupted: "Not reached",
  not_pending: "No longer waiting for approval",
  embargoed: "Release under embargo",
  press_release_not_approved: "Story not approved yet",
  suppressed: "Contact asked not to be emailed",
  review_hold: "Someone is reviewing it",
  already_pitched: "Already pitched",
  capacity: "No room in the send window",
  approve_failed: "Could not approve",
  not_allowed: "Only the artist can approve",
};

/** Why a pitch could not be asked about at all (POST 422), worded for the person asking. */
const REJECT_LABEL: Record<string, string> = {
  not_found: "Not found in this workspace",
  not_pending: "Not waiting for approval",
};

/** Skips a fresh request could clear (apps/tap/lib/approval-requests/summary.ts `ASK_AGAIN`). */
const ASK_AGAIN = new Set(["message_changed", "review_check_failed", "approve_failed", "interrupted"]);

export type Tone = "success" | "warning" | "danger" | "muted";

interface StatusCopy {
  tone: Tone;
  /** What happened, when the result alone does not say. */
  line: string | null;
  next: string | null;
}

const STATUS: Record<Exclude<ApprovalStatus, "pending">, StatusCopy> = {
  approved: { tone: "success", line: null, next: "TAP sends the approved pitches. Follow them with tap send {campaign}." },
  partial: { tone: "warning", line: null, next: "TAP sends the approved pitches. Fix the rest in TAP, then ask again with tap approve {campaign}." },
  declined: { tone: "danger", line: "Declined. Nothing was approved or sent.", next: "Edit the pitches in TAP, then ask again with tap approve {campaign}." },
  interrupted: { tone: "warning", line: "The answer stopped partway. The pitches approved below still send.", next: "Ask again for the rest with tap approve {campaign}." },
  expired: { tone: "muted", line: "Nobody answered before the request expired. Nothing was approved.", next: "Ask again with tap approve {campaign}." },
  cancelled: { tone: "muted", line: "Withdrawn. Nothing was approved.", next: "Ask again with tap approve {campaign} when you are ready." },
  superseded: { tone: "muted", line: "A newer request for the same pitches replaced this one.", next: "Answer the newer request in TAP." },
};

/** Answered, or stopped partway, with nothing approved: nothing will send. */
const NONE_APPROVED: StatusCopy = {
  tone: "warning",
  line: "Every pitch was skipped. Nothing was approved or sent.",
  next: "Fix the pitches in TAP, then ask again with tap approve {campaign}.",
};

function copyFor(status: Exclude<ApprovalStatus, "pending">, approved: number): StatusCopy {
  return approved === 0 && (status === "partial" || status === "interrupted") ? NONE_APPROVED : STATUS[status];
}

export interface PitchLine {
  id: string;
  to: string | null;
  subject: string | null;
  approved: boolean;
  reason: string | null;
}

export interface Outcome {
  status: ApprovalStatus;
  tone: Tone;
  headline: string;
  line: string | null;
  pitches: PitchLine[];
  next: string | null;
}

function headlineFor(approved: number, asked: number): string {
  if (approved === 0) return "Nothing was approved";
  return `Approved ${approved} of ${asked}`;
}

function pitchLines(request: ApprovalRequest): PitchLine[] {
  const approved = new Set(request.result?.approved ?? []);
  const skipped = new Map((request.result?.skipped ?? []).map((s) => [s.id, s.reason]));
  return request.items.map((item) => {
    const reason = skipped.get(item.pitch_id);
    return {
      id: item.pitch_id,
      to: item.to,
      subject: item.subject,
      approved: approved.has(item.pitch_id),
      reason: reason === undefined ? null : (SKIP_LABEL[reason] ?? reason.replace(/_/g, " ")),
    };
  });
}

function nextStep(request: ApprovalRequest, copy: StatusCopy, campaignId: string | undefined): string | null {
  const canAskAgain = request.result?.skipped.some((s) => ASK_AGAIN.has(s.reason)) ?? false;
  const next = request.status === "partial" && canAskAgain ? "Ask again for the skipped pitches with tap approve {campaign}." : copy.next;
  return next?.replace("{campaign}", campaignId ?? "<campaign-id>") ?? null;
}

/** A final request as the terminal reports it. A pending one reads as still waiting. */
export function describeOutcome(request: ApprovalRequest, campaignId?: string): Outcome {
  if (request.status === "pending") {
    return { status: "pending", tone: "muted", headline: "Waiting for an answer", line: null, pitches: pitchLines(request), next: `Check again with tap approve status ${request.id} --wait.` };
  }
  const approved = request.result?.approved.length ?? 0;
  const copy = copyFor(request.status, approved);
  const lead = approved === 0 && copy.line;
  return {
    status: request.status,
    tone: copy.tone,
    headline: lead || headlineFor(approved, request.item_count),
    line: lead ? null : copy.line,
    pitches: pitchLines(request),
    next: nextStep(request, copy, campaignId),
  };
}

export function rejectionLabel(pitch: RejectedPitch): string {
  return REJECT_LABEL[pitch.reason] ?? pitch.reason.replace(/_/g, " ");
}
