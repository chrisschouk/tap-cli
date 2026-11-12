/**
 * How `tap approve` reports: every ending of a request (answered, withdrawn,
 * open by choice, gone, left open), the pitches TAP refused to ask about, and
 * the same as JSON for agents.
 */

import chalk from "chalk";
import * as out from "../output.js";
import { COLOUR, GLYPH } from "./theme.js";
import { blank, summaryBar } from "./format.js";
import { describeOutcome, rejectionLabel, type Outcome, type Tone } from "../lib/approval-outcome.js";
import type { ApprovalRequest, RejectedPitch } from "../lib/approval-requests.js";
import type { Ending, RequestRef } from "../lib/approval-session.js";
import { dashboard } from "../lib/dashboard.js";
import { printAsk } from "./approve-wait.js";

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
  out.info("Send drafts for approval in TAP, or ask about the others on their own.");
}

export function rejectedJson(rejected: RejectedPitch[]) {
  return { error: "Some pitches cannot be approved now", rejected: rejected.map((r) => ({ ...r, label: rejectionLabel(r) })) };
}

export const statusCommand = (id: string) => `tap approve status ${id} --wait`;

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export interface RenderContext {
  json: boolean;
  /** Draw the QR with the ask (--no-wait on a TTY). */
  qr: boolean;
  outlets: Outlets;
  campaign: { id?: string; label?: string };
}

function stillOpenLine(ref: RequestRef): string {
  if (!ref.expires_at) return "    TAP may still have it open. A person can approve it there, and TAP sends what they approve.";
  return Date.parse(ref.expires_at) > Date.now()
    ? `    The request is still open until ${clock(ref.expires_at)}. A person can still approve it, and TAP sends what they approve.`
    : `    The request was open until ${clock(ref.expires_at)}. A person may have approved it before then, and TAP sends what they approved.`;
}

/** The request may still be answered: say why the CLI stopped, where it stands, and how to read it. */
function printLeftOpen(ref: RequestRef, reason: string): void {
  blank();
  out.error(reason);
  console.error(stillOpenLine(ref));
  blank();
  const rows: Array<[string, string | null]> = [["Request", ref.id], ["Code", ref.code], ["Link", ref.url], ["Expires", ref.expires_at && clock(ref.expires_at)]];
  for (const [label, value] of rows) if (value) console.log(`  ${chalk.dim(label.padEnd(9))}${value}`);
  blank();
  out.info(`Read the answer with ${statusCommand(ref.id)}`);
  blank();
}

function printOpen(ref: RequestRef, request: ApprovalRequest | null, ctx: RenderContext): void {
  if (request) return printOutcome(request, ctx.outlets, ctx.campaign);
  printAsk({ id: ref.id, code: ref.code ?? "", url: ref.url ?? "", expires_at: ref.expires_at ?? "", status: "pending" }, { qr: ctx.qr });
  out.info(`Check the answer with ${statusCommand(ref.id)}`);
  blank();
}

function printGone(ref: RequestRef): void {
  blank();
  out.error(`TAP has no approval request ${ref.id}.`);
  out.info("Check the id. A request belongs to the workspace whose key asked for it.");
  blank();
}

/** --json: stdout carries one object, and `outcome` names the ending. */
export function endingJson(ref: RequestRef, ending: Ending, campaignId?: string): object {
  switch (ending.kind) {
    case "answered":
    case "withdrawn":
      return { outcome: ending.kind, ...outcomeJson(ending.request, campaignId) };
    case "open":
      return ending.request
        ? { outcome: "open", ...outcomeJson(ending.request, campaignId) }
        : { outcome: "open", ...ref, status: "pending", status_command: statusCommand(ref.id) };
    case "gone":
      return { outcome: "gone", id: ref.id, status: "gone", error: "Approval request not found" };
    case "left_open":
      return { outcome: "left_open", ...ref, status: "unknown", reason: ending.reason, status_command: statusCommand(ref.id) };
  }
}

/** The one place a request's ending is reported, as text or as JSON. */
export function renderEnding(ref: RequestRef, ending: Ending, ctx: RenderContext): void {
  if (ctx.json) return out.json(endingJson(ref, ending, ctx.campaign.id));
  switch (ending.kind) {
    case "answered":
    case "withdrawn":
      return printOutcome(ending.request, ctx.outlets, ctx.campaign);
    case "open":
      return printOpen(ref, ending.request, ctx);
    case "gone":
      return printGone(ref);
    case "left_open":
      return printLeftOpen(ref, ending.reason);
  }
}

/** The create failed in a way TAP may still have carried out, so there is no id to show. */
export function printCreateUnknown(reason: string, campaignId: string, json: boolean): void {
  const url = dashboard.approveAndSend(campaignId);
  const next = `Look for it in TAP at ${url}. Asking again with tap approve ${campaignId} replaces a request nobody has started answering.`;
  if (json) return out.json({ outcome: "create_unknown", status: "unknown", reason, may_exist: true, check_url: url, next });
  blank();
  out.error(`${reason}. TAP may have created the request anyway.`);
  out.info(next);
  blank();
}
