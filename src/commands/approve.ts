/**
 * Approve command: ask a signed-in person to approve pitches, from the
 * terminal, and wait for their answer.
 *
 * The CLI creates an approval request, prints its code, link and a QR of the
 * link, and waits. The person opens the link in TAP on a phone or computer and
 * answers there. The key can only create, read and withdraw a request: it can
 * never approve or send.
 *
 * Once the request exists the command ends in one place, `finalise`, with
 * one of the endings in lib/approval-session.ts, and the exit code comes from
 * the ending: 0 when at least one pitch was approved (or the request waits by
 * choice, with --no-wait), 1 when nothing was approved, the request is gone
 * or an error left it open, 130 when the person stopped (Ctrl+C, c, SIGTERM,
 * SIGHUP).
 *
 * Usage:
 *   tap approve <campaign-id>                    choose pitches, ask, wait
 *   tap approve <campaign-id> --all              ask about every waiting pitch
 *   tap approve <campaign-id> --pitch <id> ...   ask about these pitches
 *   tap approve <campaign-id> --all --no-wait --json
 *   tap approve status <request-id> [--wait]
 */

import { Command } from "commander";
import chalk from "chalk";
import * as clack from "@clack/prompts";
import { fetchAllPages, restRequest } from "../lib/rest.js";
import { fetchPendingPitches, type PendingPitch } from "../lib/pending-pitches.js";
import {
  ApprovalRejected,
  EXIT_CODE,
  MAX_REQUEST_PITCHES,
  createApprovalRequest,
  createMayHaveLanded,
  readWithRetry,
  type CreatedRequest,
} from "../lib/approval-requests.js";
import { StopRequest, exitCodeOf, follow, refOf, type Ending, type RequestRef } from "../lib/approval-session.js";
import { describeFailure, type RetryHooks } from "../lib/retry.js";
import { dashboard } from "../lib/dashboard.js";
import { openUrl } from "../lib/browser.js";
import * as out from "../output.js";
import { COLOUR } from "../ui/theme.js";
import { campaignLabel, navHint } from "../ui/detail.js";
import { blank, createRailSpinner, stepComplete } from "../ui/format.js";
import { handleError } from "../ui/errors.js";
import { selectCampaign } from "../ui/actions.js";
import { onInterrupt } from "../ui/interrupt.js";
import { pickPitches, recipientText, type PickerPitch } from "../ui/pitch-picker.js";
import { printAsk, waitOnScreen } from "../ui/approve-wait.js";
import { pitchTable, printCreateUnknown, printRejected, rejectedJson, renderEnding, type Outlets, type RenderContext } from "../ui/approve-report.js";

interface ApproveOptions {
  all?: boolean;
  pitch?: string[];
  wait: boolean;
  json?: boolean;
}

interface CampaignRow {
  id: string;
  name: string;
  artist_name: string | null;
}

interface CampaignContactRow {
  contact: { email: string | null; outlet: string | null } | null;
}

interface Loaded {
  campaign: CampaignRow;
  pending: PendingPitch[];
  outlets: Outlets;
}

class Stop extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

const interactive = (opts: { json?: boolean }) => Boolean(process.stdin.isTTY && process.stdout.isTTY && !opts.json);

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function loadCampaign(campaignId: string): Promise<Loaded> {
  const id = encodeURIComponent(campaignId);
  const [{ campaign }, pending, contacts] = await Promise.all([
    restRequest<{ campaign: CampaignRow }>(`/api/v1/campaigns/${id}`),
    fetchPendingPitches(campaignId),
    fetchAllPages<CampaignContactRow>(`/api/v1/campaigns/${id}/contacts`, "contacts"),
  ]);
  const outlets = new Map<string, string>();
  for (const { contact } of contacts) {
    if (contact?.email && contact.outlet) outlets.set(contact.email.toLowerCase(), contact.outlet);
  }
  return { campaign, pending, outlets };
}

const waiting = (pending: PendingPitch[]) => pending.filter((p) => p.state === "pending_approval");

/** A pitch's outlet falls back to its recipient's campaign contact. */
function withOutlet(pitch: PendingPitch, outlets: Outlets): PickerPitch {
  const r = pitch.recipient;
  if (!r?.to || r.outlet) return pitch;
  return { ...pitch, recipient: { ...r, outlet: outlets.get(r.to.toLowerCase()) ?? null } };
}

/**
 * No pitch waits for approval. List the drafts and point at the TAP page where
 * the person sends them for approval; the CLI does not queue them itself.
 */
async function nothingWaiting(loaded: Loaded, opts: ApproveOptions): Promise<void> {
  const drafts = loaded.pending.filter((p) => p.state === "draft");
  const url = dashboard.approveAndSend(loaded.campaign.id);
  if (opts.json) {
    out.json({ error: "Nothing is waiting for approval", drafts: drafts.map((d) => ({ id: d.id, subject: d.subject })), review_url: url });
    return;
  }
  out.info("Nothing in this campaign is waiting for approval.");
  if (drafts.length === 0) return navHint([`tap pitch ${loaded.campaign.id}`, `tap send ${loaded.campaign.id}`]);
  blank();
  const to = (d: PendingPitch) => recipientText(withOutlet(d, loaded.outlets).recipient) ?? "";
  if (drafts.some((d) => d.recipient)) out.table(["Draft", "To"], drafts.map((d) => [d.subject, to(d)]));
  else out.table(["Draft"], drafts.map((d) => [d.subject]));
  blank();
  out.info(`${drafts.length === 1 ? "This draft has" : `These ${drafts.length} drafts have`} not been sent for approval. Send them for approval in TAP, then run tap approve ${loaded.campaign.id} again:`);
  console.log(`  ${chalk.hex(COLOUR.primary)(url)}`);
  blank();
  if (!interactive(opts)) return;
  const yes = await clack.confirm({ message: "Open it in your browser?", initialValue: true });
  if (!clack.isCancel(yes) && yes) openUrl(url, (message) => out.error(`Failed to open browser: ${message}`));
}

/** The pitches to ask about, or null when there is nothing to ask. */
async function pitchesToAsk(loaded: Loaded, opts: ApproveOptions): Promise<string[] | null> {
  if (opts.pitch?.length) return [...new Set(opts.pitch)];
  const ready = waiting(loaded.pending);
  if (ready.length === 0) {
    await nothingWaiting(loaded, opts);
    return null;
  }
  if (opts.all) return ready.map((p) => p.id);
  if (!interactive(opts)) {
    out.error("Choose the pitches with --all or --pitch <id>.");
    return null;
  }
  const chosen = await pickPitches(ready.map((p) => withOutlet(p, loaded.outlets)));
  if (!chosen) throw new Stop(EXIT_CODE.interrupted);
  return chosen;
}

function askAgainCommand(campaignId: string, opts: ApproveOptions): string {
  if (opts.all) return `tap approve ${campaignId} --all`;
  return opts.pitch?.length ? `tap approve ${campaignId} --pitch <id> for each of them` : `tap approve ${campaignId}`;
}

/** TAP takes 50 pitches a request. Say so, to stderr under --json, and how to ask about the rest. */
function capped(ids: string[], campaignId: string, opts: ApproveOptions): string[] {
  if (ids.length <= MAX_REQUEST_PITCHES) return ids;
  const rest = ids.length - MAX_REQUEST_PITCHES;
  const say = opts.json ? (m: string) => console.error(m) : out.warn;
  say(`TAP asks about up to ${MAX_REQUEST_PITCHES} pitches at a time, so this asks about the first ${MAX_REQUEST_PITCHES} of ${ids.length}.`);
  say(`Once it is answered, run ${askAgainCommand(campaignId, opts)} to ask about the other ${rest}.`);
  return ids.slice(0, MAX_REQUEST_PITCHES);
}

function askedDetail(asked: number, chosen: number, code: string): string {
  const count = asked === chosen ? (asked === 1 ? "1 pitch" : `${asked} pitches`) : `${asked} of ${chosen} pitches`;
  return `${count}, request ${code}`;
}

/** Why the create failed, for a failure TAP may have carried out anyway. */
function createFailure(err: unknown, stop: StopRequest): string {
  return stop.quit.aborted ? "You quit before TAP answered" : describeFailure(err);
}

/** Nothing exists yet unless TAP may have created the request; then say where to look, as there is no id. */
function askFailed(err: unknown, loaded: Loaded, opts: ApproveOptions, stop: StopRequest): number {
  if (err instanceof ApprovalRejected) {
    if (opts.json) out.json(rejectedJson(err.rejected));
    else printRejected(err.rejected, new Map(loaded.pending.map((p) => [p.id, p.subject])));
    return EXIT_CODE.notApproved;
  }
  if (!createMayHaveLanded(err)) throw err;
  printCreateUnknown(createFailure(err, stop), loaded.campaign.id, Boolean(opts.json));
  return stop.requested ? EXIT_CODE.interrupted : EXIT_CODE.notApproved;
}

/** The request, or the exit code when there is none. A first stop during the create withdraws once the id is known. */
async function ask(ids: string[], loaded: Loaded, opts: ApproveOptions, stop: StopRequest): Promise<CreatedRequest | number> {
  const announce = () => console.error("  Stopping. The request will be withdrawn once TAP returns it. Press Ctrl+C again to quit at once.");
  stop.signal.addEventListener("abort", announce);
  try {
    return await createApprovalRequest(ids, stop.quit);
  } catch (err) {
    return askFailed(err, loaded, opts, stop);
  } finally {
    stop.signal.removeEventListener("abort", announce);
  }
}

/** The asked pitches with their recipients, the code and the QR. */
async function showAsked(created: CreatedRequest, loaded: Loaded, opts: ApproveOptions, signal: AbortSignal, hooks: RetryHooks): Promise<void> {
  const asked = await readWithRetry(created, { ...hooks, signal });
  blank();
  pitchTable(asked.items, loaded.outlets);
  printAsk(created, { qr: interactive(opts) });
}

function waitFor(created: CreatedRequest, loaded: Loaded, opts: ApproveOptions, stop: StopRequest): Promise<Ending> {
  if (!opts.wait && !stop.requested) return Promise.resolve({ kind: "open", request: null });
  if (opts.json) console.error(`Code ${created.code}. Approve at ${created.url}. Ctrl+C withdraws the request.`);
  return waitOnScreen(created, stop, {
    keys: interactive(opts),
    countdown: !opts.json,
    onOpen: () => openUrl(created.url, (message) => out.error(`Failed to open browser: ${message}`)),
    prelude: opts.json ? undefined : (signal, hooks) => showAsked(created, loaded, opts, signal, hooks),
  });
}

/** Every command that has a request id ends here: report the ending, and return its exit code. */
function finalise(ref: RequestRef, ending: Ending, ctx: RenderContext): number {
  renderEnding(ref, ending, ctx);
  return exitCodeOf(ending);
}

/** From here on an interrupt is intent: the handler presses `stop`, and the flow turns that into an ending. */
async function withStopRequest(run: (stop: StopRequest) => Promise<number>): Promise<number> {
  const stop = new StopRequest();
  const release = onInterrupt(() => stop.press());
  try {
    return await run(stop);
  } finally {
    release();
  }
}

async function askAndWait(ids: string[], chosen: number, loaded: Loaded, opts: ApproveOptions, stop: StopRequest): Promise<number> {
  const created = await ask(ids, loaded, opts, stop);
  if (typeof created === "number") return created;
  if (!opts.json) stepComplete("Asked", askedDetail(ids.length, chosen, created.code));
  const ending = await waitFor(created, loaded, opts, stop);
  const campaign = { id: loaded.campaign.id, label: campaignLabel(loaded.campaign) };
  return finalise(refOf(created), ending, { json: Boolean(opts.json), qr: interactive(opts), outlets: loaded.outlets, campaign });
}

async function resolveCampaign(campaignId: string | undefined, opts: ApproveOptions): Promise<string> {
  if (campaignId) return campaignId;
  if (!interactive(opts)) {
    out.error("Pass a campaign ID: tap approve <campaign-id>. tap campaigns list shows them.");
    throw new Stop(EXIT_CODE.notApproved);
  }
  const chosen = await selectCampaign({ statusFilter: "active", message: "Which campaign?" });
  if (!chosen) throw new Stop(EXIT_CODE.interrupted);
  return chosen;
}

async function loadWithSpinner(campaignId: string, opts: ApproveOptions): Promise<Loaded> {
  const rail = createRailSpinner("Loading pitches").start();
  try {
    const loaded = await loadCampaign(campaignId);
    if (opts.json) rail.stop();
    else rail.succeed("Loaded", `${campaignLabel(loaded.campaign)}, ${waiting(loaded.pending).length} waiting for approval`);
    return loaded;
  } catch (err) {
    rail.fail("Could not load pitches");
    throw err;
  }
}

async function runApprove(campaignArg: string | undefined, opts: ApproveOptions): Promise<number> {
  const campaignId = await resolveCampaign(campaignArg, opts);
  const loaded = await loadWithSpinner(campaignId, opts);
  const chosen = await pitchesToAsk(loaded, opts);
  if (!chosen) return EXIT_CODE.notApproved;
  const ids = capped(chosen, campaignId, opts);
  return withStopRequest((stop) => askAndWait(ids, chosen.length, loaded, opts, stop));
}

function runStatus(requestId: string, opts: { wait?: boolean; json?: boolean }): Promise<number> {
  return withStopRequest(async (stop) => {
    const { ref, ending } = await follow(requestId, { wait: Boolean(opts.wait), stop });
    return finalise(ref, ending, { json: Boolean(opts.json), qr: false, outlets: new Map(), campaign: {} });
  });
}

/**
 * The process exits here and nowhere else. Errors that reach it come from
 * before a request exists. Inside the interactive menu `process.exit` throws
 * back to the menu, after every finally block has run.
 */
function exiting(run: () => Promise<number>): Promise<void> {
  return run().then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof Stop) process.exit(err.code);
      handleError(err);
      process.exit(EXIT_CODE.notApproved);
    },
  );
}
export function approveCommand(): Command {
  const cmd = new Command("approve")
    .description("Ask a signed-in person to approve pitches in TAP, then wait for their answer. Never approves or sends.")
    .argument("[campaign-id]", "Campaign ID (choose one when omitted)")
    .option("--all", "Ask about every pitch waiting for approval")
    .option("--pitch <id>", "Ask about this pitch (repeat for more)", collect, [])
    .option("--no-wait", "Return as soon as the request exists; check it with tap approve status")
    .option("--json", "Output as JSON")
    .enablePositionalOptions()
    .action((campaignId: string | undefined, opts: ApproveOptions) => exiting(() => runApprove(campaignId, opts)));

  cmd
    .command("status")
    .description("Show an approval request's answer")
    .argument("<request-id>", "Approval request ID")
    .option("--wait", "Wait until a person answers or the request expires")
    .option("--json", "Output as JSON")
    .action((requestId: string, opts: { wait?: boolean; json?: boolean }) => exiting(() => runStatus(requestId, opts)));

  return cmd;
}
