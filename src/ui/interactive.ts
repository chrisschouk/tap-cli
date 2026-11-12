/**
 * Interactive mode -- bare `tap` launches a guided menu.
 *
 * Loops through main menu until user selects Exit or presses Ctrl+C.
 * Supports drill-down from list views into detail views with back navigation.
 * Reads go through the REST v1 API; every action runs the matching `tap` command.
 */

import * as prompts from "@clack/prompts";
import chalk from "chalk";
import { intro, blank, type WorkspaceHints } from "./format.js";
import { runCommand } from "./run-command.js";
import { VERSION } from "../program.js";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import {
  contactActionMenu,
  campaignActionMenu,
  selectCampaign,
  selectCampaignContact,
  outcomePrompt,
  statusPrompt,
} from "./actions.js";

type Hints = WorkspaceHints;

interface ContactRow {
  id: string;
  name: string | null;
  email: string;
  outlet: string | null;
}

let cachedHints: Hints | null = null;
let hintsCachedAt = 0;
const HINTS_TTL = 60_000;

function reportError(err: unknown): void {
  if (err instanceof Error && err.message) console.error(chalk.red(err.message));
}

async function countFollowUps(): Promise<number> {
  try {
    const { actions } = await restRequest<{ actions: Array<{ type: string }> }>("/api/v1/actions");
    return actions.filter((a) => a.type === "overdue_followup").length;
  } catch {
    return 0;
  }
}

async function fetchHints(): Promise<Hints | null> {
  if (cachedHints && Date.now() - hintsCachedAt < HINTS_TTL) return cachedHints;
  try {
    const [campaigns, contacts, followUps] = await Promise.all([
      restRequest<{ total: number }>("/api/v1/campaigns", { query: { status: "active", limit: 1 } }),
      restRequest<{ total: number }>("/api/v1/contacts", { query: { limit: 1 } }),
      countFollowUps(),
    ]);
    cachedHints = { campaigns: campaigns.total, contacts: contacts.total, followUps };
    hintsCachedAt = Date.now();
    return cachedHints;
  } catch (err) {
    reportError(err);
    return null;
  }
}

const MENU: Record<string, () => Promise<void>> = {
  campaigns: campaignsMenu,
  contacts: contactsMenu,
  pitch: async () => {
    const campaignId = await selectCampaign({ statusFilter: "active", message: "Which campaign?" });
    if (campaignId) await runCommand(["pitch", campaignId]);
  },
  approve: () => runCommand(["approve"]),
  send: () => withCampaign("Which campaign?", (id) => runCommand(["send", id])),
  outcome: outcomeMenu,
  queue: () => runCommand(["queue"]),
  discover: () => runCommand(["discover"]),
  import: importMenu,
  stats: () => runCommand(["stats"]),
  watch: watchMenu,
  open: () => runCommand(["open"]),
};

function mainMenuOptions(hints: Hints | null) {
  const queueHint = hints ? (hints.followUps > 0 ? `${hints.followUps} follow-ups due` : "all clear") : "";
  return [
    { value: "campaigns", label: "Campaigns", hint: hints ? `${hints.campaigns} active` : "list, create, view details" },
    { value: "contacts", label: "Contacts", hint: hints ? `${hints.contacts} total` : "list, search, view details" },
    { value: "pitch", label: "Pitch", hint: "generate AI pitch drafts" },
    { value: "approve", label: "Approve", hint: "ask a person to approve pitches in TAP" },
    { value: "send", label: "Send", hint: "pitches waiting for your approval in TAP" },
    { value: "outcome", label: "Outcome", hint: "log a campaign outcome" },
    { value: "queue", label: "Queue", hint: queueHint || "today's action queue" },
    { value: "discover", label: "Discover", hint: "find new contacts in TAP" },
    { value: "import", label: "Import", hint: "from sink, CSV or JSON" },
    { value: "stats", label: "Stats", hint: "workspace statistics in TAP" },
    { value: "watch", label: "Watch", hint: "live campaign updates in TAP" },
    { value: "open", label: "Open TAP", hint: "open in browser" },
    { value: "exit", label: "Exit" },
  ];
}

export async function runInteractive(): Promise<void> {
  intro(VERSION, { contextBar: (await fetchHints()) || undefined });

  while (true) {
    const action = await prompts.select({
      message: "What would you like to do?",
      options: mainMenuOptions(await fetchHints()),
    });

    if (prompts.isCancel(action) || action === "exit") {
      console.log(chalk.dim("  Cheers."));
      blank();
      break;
    }

    try {
      await MENU[action]();
    } catch (err) {
      reportError(err);
    }
  }
}

async function withCampaign(message: string, run: (id: string) => Promise<void>): Promise<void> {
  const campaignId = await selectCampaign({ message });
  if (campaignId) await run(campaignId);
}

async function requiredText(message: string, placeholder?: string): Promise<string | null> {
  const value = await prompts.text({
    message,
    placeholder,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  return prompts.isCancel(value) ? null : value;
}

async function campaignDrillDown(): Promise<void> {
  const { campaigns } = await restRequest<{
    campaigns: Array<{ id: string; name: string; artist_name: string | null; status: string }>;
  }>("/api/v1/campaigns", { query: { limit: 20 } });

  if (campaigns.length === 0) {
    console.log(chalk.dim("  No campaigns found"));
    return;
  }

  await runCommand(["campaigns", "list"]);

  while (true) {
    const drill = await prompts.select({
      message: "View campaign details?",
      options: [
        ...campaigns.map((c) => ({
          value: c.id,
          label: `${c.name}${c.artist_name ? ` (${c.artist_name})` : ""}`,
          hint: c.status,
        })),
        { value: "back", label: chalk.dim("Back") },
      ],
    });
    if (prompts.isCancel(drill) || drill === "back") return;

    blank();
    await runCommand(["campaigns", "show", drill]);
    if ((await campaignActionMenu(drill)) !== "back") return;
  }
}

async function createCampaignPrompt(): Promise<void> {
  const name = await requiredText("Campaign name");
  if (!name) return;
  const artist = await prompts.text({ message: "Artist name (optional)" });
  if (prompts.isCancel(artist)) return;

  const args = ["campaigns", "create", "--name", name];
  if (artist) args.push("--artist", artist);
  await runCommand(args);
}

const CAMPAIGN_MENU: Record<string, () => Promise<void>> = {
  list: campaignDrillDown,
  show: async () => {
    const id = await requiredText("Campaign ID");
    if (!id) return;
    blank();
    await runCommand(["campaigns", "show", id]);
  },
  create: createCampaignPrompt,
  status: () => withCampaign("Which campaign?", async (id) => void (await statusPrompt(id))),
};

async function campaignsMenu(): Promise<void> {
  while (true) {
    const action = await prompts.select({
      message: "Campaigns",
      options: [
        { value: "list", label: "List campaigns" },
        { value: "show", label: "Show campaign details" },
        { value: "create", label: "Create campaign" },
        { value: "status", label: "Change status" },
        { value: "back", label: chalk.dim("Back") },
      ],
    });
    if (prompts.isCancel(action) || action === "back") return;
    try {
      await CAMPAIGN_MENU[action]();
    } catch (err) {
      reportError(err);
    }
  }
}

async function listContacts(search?: string): Promise<void> {
  const spinner = out.spinner(search ? "Searching..." : "Fetching contacts...");
  const { contacts } = await restRequest<{ contacts: ContactRow[] }>("/api/v1/contacts", {
    query: { search, limit: 20 },
  });
  spinner.stop();

  if (contacts.length === 0) {
    console.log(chalk.dim(search ? `  No contacts matching "${search}"` : "  No contacts found"));
    return;
  }

  await runCommand(search ? ["contacts", "search", search] : ["contacts", "list", "--limit", "20"]);
  await contactListDrillDown(contacts);
}

async function addContactPrompt(): Promise<void> {
  const name = await requiredText("Contact name");
  if (!name) return;

  const email = await prompts.text({
    message: "Email",
    validate: (v) => {
      if (!v?.trim()) return "Required";
      if (!v.includes("@")) return "Invalid email";
      return undefined;
    },
  });
  if (prompts.isCancel(email)) return;

  const outlet = await prompts.text({ message: "Outlet (optional)", placeholder: "e.g. BBC Radio 2, NME" });
  if (prompts.isCancel(outlet)) return;

  const args = ["contacts", "add", "--name", name, "--email", email];
  if (outlet) args.push("--outlet", outlet);
  await runCommand(args);
}

const CONTACT_MENU: Record<string, () => Promise<void>> = {
  list: () => listContacts(),
  search: async () => {
    const query = await requiredText("Search query", "e.g. Radio 1, BBC, DJ");
    if (query) await listContacts(query);
  },
  show: async () => {
    const idOrEmail = await requiredText("Contact ID or email");
    if (!idOrEmail) return;
    blank();
    await runCommand(["contacts", "show", idOrEmail]);
    await contactActionMenu(idOrEmail);
  },
  history: async () => {
    const idOrEmail = await requiredText("Contact ID or email");
    if (!idOrEmail) return;
    blank();
    await runCommand(["contacts", "history", idOrEmail]);
  },
  add: addContactPrompt,
};

async function contactsMenu(): Promise<void> {
  while (true) {
    const action = await prompts.select({
      message: "Contacts",
      options: [
        { value: "list", label: "List contacts" },
        { value: "search", label: "Search contacts" },
        { value: "show", label: "View contact details" },
        { value: "history", label: "Contact history" },
        { value: "add", label: "Add contact" },
        { value: "back", label: chalk.dim("Back") },
      ],
    });
    if (prompts.isCancel(action) || action === "back") return;
    try {
      await CONTACT_MENU[action]();
    } catch (err) {
      reportError(err);
    }
  }
}

async function outcomeMenu(): Promise<void> {
  const campaignId = await selectCampaign({ message: "Which campaign?" });
  if (!campaignId) return;
  const contactId = await selectCampaignContact(campaignId, { message: "Which contact?" });
  if (!contactId) return;
  blank();
  await outcomePrompt(campaignId, contactId);
}

async function importMenu(): Promise<void> {
  const file = await requiredText("File path (CSV, JSON, or JSONL)", "e.g. contacts.csv");
  if (file) await runCommand(["import", file]);
}

async function watchMenu(): Promise<void> {
  const mode = await prompts.select({
    message: "Watch mode",
    options: [
      { value: "workspace", label: "Workspace overview" },
      { value: "campaign", label: "Single campaign" },
    ],
  });
  if (prompts.isCancel(mode)) return;
  if (mode === "workspace") return runCommand(["watch"]);
  await withCampaign("Which campaign to watch?", (id) => runCommand(["watch", id]));
}

/**
 * Drill-down from a contact list into details and actions.
 */
async function contactListDrillDown(contacts: ContactRow[]): Promise<void> {
  while (true) {
    const drill = await prompts.select({
      message: "View contact details?",
      options: [
        ...contacts.map((c) => ({ value: c.id, label: c.name || c.email, hint: c.outlet || undefined })),
        { value: "back", label: chalk.dim("Back") },
      ],
    });
    if (prompts.isCancel(drill) || drill === "back") return;

    blank();
    await runCommand(["contacts", "show", drill]);
    await contactActionMenu(drill);
  }
}
