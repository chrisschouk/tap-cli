/**
 * Shared action helpers -- reusable interactive flows that any screen can call.
 *
 * Reads go through the REST v1 API. Writes run the matching `tap` command, so
 * every write takes the same path as the command line.
 */

import * as prompts from "@clack/prompts";
import chalk from "chalk";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import { GLYPH } from "./theme.js";
import { blank } from "./format.js";
import { campaignLabel } from "./detail.js";
import { runCommand } from "./run-command.js";
import { VALID_OUTCOME_TYPES } from "../lib/outcome-mapping.js";

interface CampaignRow {
  id: string;
  name: string;
  artist_name: string | null;
  status: string;
}

interface CampaignContactRow {
  pitch_status: string | null;
  contact: { id: string; name: string | null; email: string; outlet: string | null } | null;
}

const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed", "archived"];
const BACK = "__back__";

/**
 * Select a campaign from the workspace.
 * Returns campaign ID or null if cancelled.
 */
export async function selectCampaign(
  opts?: { statusFilter?: string; message?: string },
): Promise<string | null> {
  const spinner = out.spinner("Loading campaigns...");
  const { campaigns } = await restRequest<{ campaigns: CampaignRow[] }>("/api/v1/campaigns", {
    query: { status: opts?.statusFilter, limit: 20 },
  });
  spinner.stop();

  if (campaigns.length === 0) {
    out.info("No campaigns found");
    return null;
  }

  const selected = await prompts.select({
    message: opts?.message || "Select campaign",
    options: [
      ...campaigns.map((c) => ({ value: c.id, label: campaignLabel(c), hint: c.status })),
      { value: BACK, label: chalk.dim("Cancel") },
    ],
  });

  if (prompts.isCancel(selected) || selected === BACK) return null;
  return selected;
}

/**
 * Select a contact from a campaign.
 * Returns contact ID or null if cancelled.
 */
export async function selectCampaignContact(
  campaignId: string,
  opts?: { message?: string },
): Promise<string | null> {
  const spinner = out.spinner("Loading contacts...");
  const { contacts } = await restRequest<{ contacts: CampaignContactRow[] }>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/contacts`,
    { query: { limit: 100 } },
  );
  spinner.stop();

  const rows = contacts.filter((c) => c.contact);
  if (rows.length === 0) {
    out.info("No contacts in this campaign");
    return null;
  }

  const selected = await prompts.select({
    message: opts?.message || "Select contact",
    options: [
      ...rows.map((c) => ({
        value: c.contact!.id,
        label: c.contact!.name || c.contact!.email,
        hint: [c.contact!.outlet, c.pitch_status].filter(Boolean).join(` ${chalk.dim(GLYPH.dot)} `) || undefined,
      })),
      { value: BACK, label: chalk.dim("Cancel") },
    ],
  });

  if (prompts.isCancel(selected) || selected === BACK) return null;
  return selected;
}

/**
 * Interactive outcome logging -- prompts for type and notes, then runs
 * `tap outcome`.
 */
export async function outcomePrompt(campaignId: string, contactId: string): Promise<void> {
  const outcomeType = await prompts.select({
    message: "Outcome type",
    options: VALID_OUTCOME_TYPES.map((t) => ({ value: t as string, label: t.replace(/_/g, " ") })),
  });
  if (prompts.isCancel(outcomeType)) return;

  const notes = await prompts.text({
    message: "Notes (optional)",
    placeholder: "e.g. Loved the track, wants exclusive",
  });
  if (prompts.isCancel(notes)) return;

  const args = ["outcome", campaignId, contactId, outcomeType];
  if (notes) args.push("--notes", notes);
  await runCommand(args);
}

async function campaignFor(campaignId: string | undefined, statusFilter?: string): Promise<string | null> {
  if (campaignId) return campaignId;
  return selectCampaign({ statusFilter, message: "Which campaign?" });
}

type ContactAction = "pitch" | "outcome" | "enrich" | "history" | "open" | "back";

async function pitchContact(contactId: string, campaignId?: string): Promise<boolean> {
  const id = await campaignFor(campaignId, "active");
  if (id) await runCommand(["pitch", id, contactId]);
  return Boolean(id);
}

async function logContactOutcome(contactId: string, campaignId?: string): Promise<boolean> {
  const id = await campaignFor(campaignId);
  if (!id) return false;
  blank();
  await outcomePrompt(id, contactId);
  return true;
}

const CONTACT_ACTIONS: Record<Exclude<ContactAction, "back">, (contactId: string, campaignId?: string) => Promise<boolean>> = {
  pitch: pitchContact,
  outcome: logContactOutcome,
  enrich: async (contactId) => (await runCommand(["contacts", "enrich", contactId]), true),
  history: async (contactId) => (await runCommand(["contacts", "history", contactId]), true),
  open: async (contactId) => (await runCommand(["open", contactId]), true),
};

/**
 * Contact action menu -- pitch, outcome, enrich, view, open.
 * Returns the action taken so callers can react.
 */
export async function contactActionMenu(
  contactId: string,
  opts?: { campaignId?: string; showHistory?: boolean },
): Promise<ContactAction> {
  const options: Array<{ value: ContactAction; label: string; hint?: string }> = [
    { value: "pitch", label: "Generate pitch", hint: "AI draft" },
    { value: "outcome", label: "Log outcome" },
    { value: "enrich", label: "Enrich contact", hint: "AI enrichment" },
  ];
  if (opts?.showHistory !== false) options.push({ value: "history", label: "View history" });
  options.push({ value: "open", label: "Open in TAP" });
  options.push({ value: "back", label: chalk.dim("Back") });

  const action = await prompts.select({ message: "What next?", options });
  if (prompts.isCancel(action) || action === "back") return "back";

  const done = await CONTACT_ACTIONS[action](contactId, opts?.campaignId);
  return done ? action : "back";
}

/**
 * Campaign action menu -- pitch a contact, change status, log outcome, view.
 */
export async function campaignActionMenu(
  campaignId: string,
): Promise<"pitch" | "status" | "outcome" | "contacts" | "open" | "back"> {
  const action = await prompts.select({
    message: "What next?",
    options: [
      { value: "pitch" as const, label: "Pitch a contact", hint: "select unpitched" },
      { value: "outcome" as const, label: "Log outcome", hint: "select contact" },
      { value: "status" as const, label: "Change status" },
      { value: "contacts" as const, label: "View contacts" },
      { value: "open" as const, label: "Open in TAP" },
      { value: "back" as const, label: chalk.dim("Back") },
    ],
  });
  if (prompts.isCancel(action)) return "back";

  switch (action) {
    case "pitch":
      await runCommand(["pitch", campaignId]);
      return "pitch";
    case "outcome": {
      const contactId = await selectCampaignContact(campaignId, { message: "Select contact for outcome" });
      if (!contactId) return "back";
      blank();
      await outcomePrompt(campaignId, contactId);
      return "outcome";
    }
    case "status": {
      const changed = await statusPrompt(campaignId);
      return changed ? "status" : "back";
    }
    case "contacts":
      await runCommand(["campaigns", "show", campaignId]);
      return "contacts";
    case "open":
      await runCommand(["open", campaignId]);
      return "open";
    default:
      return "back";
  }
}

/** Prompt for a new campaign status, then run `tap campaigns status`. */
export async function statusPrompt(campaignId: string): Promise<boolean> {
  const status = await prompts.select({
    message: "New status",
    options: CAMPAIGN_STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
  });
  if (prompts.isCancel(status)) return false;
  await runCommand(["campaigns", "status", campaignId, status]);
  return true;
}
