/**
 * How `tap approve` reports: the per-pitch outcome once a person answers, the
 * pitches TAP refused to ask about, and the same as JSON for agents.
 */

import chalk from "chalk";
import * as out from "../output.js";
import { COLOUR, GLYPH } from "./theme.js";
import { blank, summaryBar } from "./format.js";
import { describeOutcome, rejectionLabel, type Outcome, type Tone } from "../lib/approval-outcome.js";
import type { ApprovalRequest, RejectedPitch } from "../lib/approval-requests.js";

/** Recipient email to outlet, from the campaign's contacts. */
export type Outlets = ReadonlyMap<string, string>;

const TONE_COLOUR: Record<Tone, string> = {
  success: COLOUR.success,
  warning: COLOUR.warning,
  danger: COLOUR.danger,
  muted: COLOUR.muted,
};

const TONE_GLYPH: Record<Tone, string> = {
  success: GLYPH.check,
  warning: "!",
  danger: GLYPH.cross,
  muted: GLYPH.diamond,
};

function outletOf(outlets: Outlets, to: string | null): string {
  return (to && outlets.get(to.toLowerCase())) || "";
}

export function pitchTable(items: ApprovalRequest["items"], outlets: Outlets): void {
  out.table(
    ["To", "Outlet", "Subject"],
    items.map((i) => [i.to ?? "", outletOf(outlets, i.to), i.subject ?? ""]),
  );
}

function resultCell(approved: boolean, reason: string | null): string {
  if (approved) return chalk.hex(COLOUR.success)("approved");
  return chalk.hex(COLOUR.warning)(reason ?? "not approved");
}

function answeredLine(request: ApprovalRequest): string | null {
  if (!request.answered_at) return null;
  const at = new Date(request.answered_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `Answered in TAP at ${at}`;
}

function printHeadline(outcome: Outcome, request: ApprovalRequest): void {
  const colour = chalk.hex(TONE_COLOUR[outcome.tone]);
  const answered = answeredLine(request);
  console.log(`  ${colour(TONE_GLYPH[outcome.tone])} ${colour.bold(outcome.headline)}${answered ? chalk.dim(`  ${GLYPH.dot}  ${answered}`) : ""}`);
  if (outcome.line) console.log(`    ${outcome.line}`);
}

function countParts(request: ApprovalRequest): string[] {
  if (request.status === "pending") return [`${request.item_count} waiting`];
  const approved = request.result?.approved.length ?? 0;
  return [`${approved} approved`, `${request.item_count - approved} not approved`];
}

export function printOutcome(request: ApprovalRequest, outlets: Outlets, campaign: { id?: string; label?: string }): void {
  const outcome = describeOutcome(request, campaign.id);
  blank();
  printHeadline(outcome, request);
  if (request.status === "pending") console.log(`    Code ${chalk.bold(request.code)}  ${chalk.hex(COLOUR.primary)(request.url)}`);
  if (request.result && request.result.approved.length + request.result.skipped.length > 0) {
    blank();
    out.table(
      ["", "To", "Outlet", "Subject", "Result"],
      outcome.pitches.map((p) => [
        p.approved ? chalk.hex(COLOUR.success)(GLYPH.check) : chalk.dim(GLYPH.dot),
        p.to ?? "",
        outletOf(outlets, p.to),
        p.subject ?? "",
        resultCell(p.approved, p.reason),
      ]),
    );
  }
  blank();
  if (outcome.next) out.info(outcome.next);
  out.info("The CLI never approves or sends. Approval happens in TAP, by a person.");
  blank();
  summaryBar([...countParts(request), ...(campaign.label ? [campaign.label] : [])]);
  blank();
}

export function outcomeJson(request: ApprovalRequest, campaignId?: string) {
  const { headline, line, pitches, next } = describeOutcome(request, campaignId);
  return { request, summary: { headline, line, pitches, next } };
}

export function printRejected(rejected: RejectedPitch[], subjects: ReadonlyMap<string, string>): void {
  out.error(rejected.length === 1 ? "TAP cannot ask about this pitch now" : `TAP cannot ask about ${rejected.length} of these pitches now`);
  blank();
  out.table(
    ["Pitch", "Why"],
    rejected.map((r) => [subjects.get(r.id) ?? r.id, chalk.hex(COLOUR.warning)(rejectionLabel(r))]),
  );
  blank();
  out.info("Nothing was asked. Only pitches waiting for approval can go in a request.");
  out.info("Queue drafts for review in TAP, or ask about the others on their own.");
}

export function rejectedJson(rejected: RejectedPitch[]) {
  return { error: "Some pitches cannot be approved now", rejected: rejected.map((r) => ({ ...r, label: rejectionLabel(r) })) };
}
