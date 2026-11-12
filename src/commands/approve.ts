/**
 * Approve command: ask a signed-in person to approve pitches, from the
 * terminal, and wait for their answer.
 *
 * The CLI creates an approval request, prints its code, link and a QR of the
 * link, and waits. The person opens the link in TAP on a phone or computer and
 * answers there. The key can only create, read and withdraw a request: it can
 * never approve or send.
 *
 * Usage:
 *   tap approve <campaign-id>                    choose pitches, ask, wait
 *   tap approve <campaign-id> --all              ask about every waiting pitch
 *   tap approve <campaign-id> --pitch <id> ...   ask about these pitches
 *   tap approve <campaign-id> --all --no-wait --json
 *   tap approve status <request-id> [--wait]
 */

import { Command } from "commander";
import * as clack from "@clack/prompts";
import { fetchAllPages, restRequest } from "../lib/rest.js";
import { fetchPendingPitches, type PendingPitch } from "../lib/pending-pitches.js";
import {
  ApprovalRejected,
  MAX_REQUEST_PITCHES,
  createApprovalRequest,
  exitCodeFor,
  readApprovalRequest,
  waitForAnswer,
  type ApprovalRequest,
  type CreatedRequest,
} from "../lib/approval-requests.js";
import { openUrl } from "../lib/browser.js";
import * as out from "../output.js";
import { campaignLabel, navHint } from "../ui/detail.js";
import { blank, createRailSpinner, stepComplete } from "../ui/format.js";
import { handleError } from "../ui/errors.js";
import { selectCampaign } from "../ui/actions.js";
import { pickPitches } from "../ui/pitch-picker.js";
import { awaitAnswer, printAsk } from "../ui/approve-wait.js";
import { outcomeJson, pitchTable, printOutcome, printRejected, rejectedJson, type Outlets } from "../ui/approve-report.js";

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

/**
 * POST /api/v1/pitches/:id/propose moves a draft into the approval queue with
 * a reason. It sets approval_state to pending_approval and nothing else: it
 * never approves or sends (apps/tap/lib/campaigns/pitch-review-handoff.ts).
 */
async function queueDraft(id: string): Promise<string | null> {
  try {
    await restRequest(`/api/v1/pitches/${encodeURIComponent(id)}/propose`, {
      method: "POST",
      body: { reason: "Queued for review from the terminal with tap approve.", confidence: 1, agent_name: "tap-cli" },
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function offerToQueueDrafts(drafts: PendingPitch[]): Promise<boolean> {
  const yes = await clack.confirm({
    message: `Queue ${drafts.length === 1 ? "it" : `all ${drafts.length}`} for review now? This approves and sends nothing.`,
    initialValue: true,
  });
  if (clack.isCancel(yes) || !yes) return false;
  const rail = createRailSpinner("Queueing drafts for review").start();
  const failures = (await Promise.all(drafts.map(async (d) => [d, await queueDraft(d.id)] as const))).filter(([, e]) => e);
  rail.succeed("Queued", `${drafts.length - failures.length} of ${drafts.length} drafts now wait for approval`);
  for (const [draft, message] of failures) out.warn(`${out.truncate(draft.subject, 40)}: ${message}`);
  return failures.length < drafts.length;
}

/** No pitch waits for approval. Say so, and offer to queue any drafts. Returns true when some now wait. */
async function nothingWaiting(loaded: Loaded, opts: ApproveOptions): Promise<boolean> {
  const drafts = loaded.pending.filter((p) => p.state === "draft");
  if (opts.json) {
    out.json({ error: "Nothing is waiting for approval", drafts: drafts.map((d) => ({ id: d.id, subject: d.subject })) });
    return false;
  }
  out.info("Nothing in this campaign is waiting for approval.");
  if (drafts.length === 0) {
    navHint([`tap pitch ${loaded.campaign.id}`, `tap send ${loaded.campaign.id}`]);
    return false;
  }
  out.info(`${drafts.length === 1 ? "1 draft has" : `${drafts.length} drafts have`} not been queued for review yet.`);
  if (interactive(opts)) return offerToQueueDrafts(drafts);
  out.info(`Queue them for review in TAP, or run tap approve ${loaded.campaign.id} in a terminal to queue them here.`);
  return false;
}

async function choosePitches(loaded: Loaded, opts: ApproveOptions): Promise<string[] | null> {
  if (opts.pitch?.length) return opts.pitch;
  const ready = waiting(loaded.pending);
  if (opts.all) return ready.map((p) => p.id);
  if (!interactive(opts)) {
    out.error("Choose the pitches with --all or --pitch <id>.");
    return null;
  }
  const chosen = await pickPitches(ready);
  if (!chosen) throw new Stop(0);
  return chosen;
}

function capped(ids: string[], opts: ApproveOptions): string[] {
  if (ids.length <= MAX_REQUEST_PITCHES) return ids;
  if (!opts.json) out.warn(`TAP asks about up to ${MAX_REQUEST_PITCHES} pitches at a time. Asking about the first ${MAX_REQUEST_PITCHES}; run again for the rest.`);
  return ids.slice(0, MAX_REQUEST_PITCHES);
}

async function ask(ids: string[], loaded: Loaded, opts: ApproveOptions): Promise<CreatedRequest> {
  try {
    return await createApprovalRequest(ids);
  } catch (err) {
    if (!(err instanceof ApprovalRejected)) throw err;
    if (opts.json) out.json(rejectedJson(err.rejected));
    else printRejected(err.rejected, new Map(loaded.pending.map((p) => [p.id, p.subject])));
    throw new Stop(1);
  }
}

function reportNoWait(created: CreatedRequest, opts: ApproveOptions): void {
  const statusCommand = `tap approve status ${created.id} --wait`;
  if (opts.json) return out.json({ ...created, status_command: statusCommand });
  printAsk(created, { qr: interactive(opts) });
  out.info(`Check the answer with ${statusCommand}`);
  blank();
}

async function waitInJson(created: CreatedRequest, campaignId: string): Promise<ApprovalRequest> {
  console.error(`Code ${created.code}. Approve at ${created.url}. Ctrl+C withdraws the request.`);
  const request = await awaitAnswer(created, { keys: false, countdown: false, onOpen: () => {} });
  out.json(outcomeJson(request, campaignId));
  return request;
}

async function waitOnScreen(created: CreatedRequest, loaded: Loaded, opts: ApproveOptions): Promise<ApprovalRequest> {
  const asked = await readApprovalRequest(created.id);
  blank();
  pitchTable(asked.items, loaded.outlets);
  printAsk(created, { qr: interactive(opts) });
  const onOpen = () => openUrl(created.url, (message) => out.error(`Failed to open browser: ${message}`));
  const request = await awaitAnswer(created, { keys: interactive(opts), countdown: true, onOpen });
  printOutcome(request, loaded.outlets, { id: loaded.campaign.id, label: campaignLabel(loaded.campaign) });
  return request;
}

async function resolveCampaign(campaignId: string | undefined, opts: ApproveOptions): Promise<string> {
  if (campaignId) return campaignId;
  if (!interactive(opts)) {
    out.error("Pass a campaign ID: tap approve <campaign-id>. tap campaigns list shows them.");
    throw new Stop(1);
  }
  const chosen = await selectCampaign({ statusFilter: "active", message: "Which campaign?" });
  if (!chosen) throw new Stop(0);
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

/** The pitches to ask about, queueing drafts first when nothing waits. Null when nothing can be asked. */
async function pitchesToAsk(campaignId: string, loaded: Loaded, opts: ApproveOptions): Promise<string[] | null> {
  if (opts.pitch?.length || waiting(loaded.pending).length > 0) return choosePitches(loaded, opts);
  if (!(await nothingWaiting(loaded, opts))) return null;
  const reloaded = { ...loaded, pending: await fetchPendingPitches(campaignId) };
  return choosePitches(reloaded, opts);
}

async function runApprove(campaignArg: string | undefined, opts: ApproveOptions): Promise<number> {
  const campaignId = await resolveCampaign(campaignArg, opts);
  const loaded = await loadWithSpinner(campaignId, opts);
  const ids = await pitchesToAsk(campaignId, loaded, opts);
  if (!ids) return 1;
  const created = await ask(capped(ids, opts), loaded, opts);
  if (!opts.json) stepComplete("Asked", `${ids.length === 1 ? "1 pitch" : `${ids.length} pitches`}, request ${created.code}`);
  if (!opts.wait) {
    reportNoWait(created, opts);
    return 0;
  }
  const request = opts.json ? await waitInJson(created, campaignId) : await waitOnScreen(created, loaded, opts);
  return exitCodeFor(request);
}

async function runStatus(requestId: string, opts: { wait?: boolean; json?: boolean }): Promise<number> {
  const request = opts.wait ? await waitForAnswer(requestId) : await readApprovalRequest(requestId);
  if (opts.json) out.json(outcomeJson(request));
  else printOutcome(request, new Map(), {});
  return exitCodeFor(request);
}

function exiting(run: () => Promise<number>): Promise<void> {
  return run().then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof Stop) process.exit(err.code);
      handleError(err);
      process.exit(1);
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
