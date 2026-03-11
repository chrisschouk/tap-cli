/**
 * Interactive mode -- bare `tap` launches a guided menu.
 *
 * Loops through main menu until user selects Exit or presses Ctrl+C.
 * Supports drill-down from list views into detail views with back navigation.
 * Every screen offers actions -- pitch, outcome, enrich, send.
 */

import * as prompts from "@clack/prompts";
import chalk from "chalk";
import { intro, blank } from "./format.js";
import { GLYPH } from "./theme.js";
import { VERSION } from "../cli.js";
import { getClient, resolveWorkspaceId } from "../auth.js";
import { showContact, showHistory } from "../commands/contacts.js";
import { showCampaign } from "../commands/campaigns.js";
import * as out from "../output.js";
import { contactActionMenu, campaignActionMenu } from "./actions.js";

export async function runInteractive(): Promise<void> {
  // Fetch context stats before rendering intro
  let contextBar: { contacts: number; campaigns: number; followUps: number } | null = null;

  try {
    const supabase = getClient();
    const wsId = await resolveWorkspaceId(supabase);

    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const [campResult, contactResult, followUpResult] = await Promise.all([
      supabase
        .from("tap_projects")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", wsId)
        .eq("status", "active"),
      supabase
        .from("tap_contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", wsId),
      supabase
        .from("campaign_contacts")
        .select("contact_id", { count: "exact", head: true })
        .eq("pitch_status", "sent")
        .lt("last_pitched_at", threeDaysAgo.toISOString()),
    ]);

    contextBar = {
      contacts: contactResult.count || 0,
      campaigns: campResult.count || 0,
      followUps: followUpResult.count || 0,
    };
  } catch {
    // Non-critical
  }

  intro(VERSION, { commands: true, contextBar: contextBar || undefined });

  while (true) {
    // Refresh hints each loop
    let campaignHint = "";
    let contactHint = "";
    let queueHint = "";

    try {
      const supabase = getClient();
      const wsId = await resolveWorkspaceId(supabase);

      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      const [campResult, contactResult, followUpResult] = await Promise.all([
        supabase
          .from("tap_projects")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", wsId)
          .eq("status", "active"),
        supabase
          .from("tap_contacts")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", wsId),
        supabase
          .from("campaign_contacts")
          .select("contact_id", { count: "exact", head: true })
          .eq("pitch_status", "sent")
          .lt("last_pitched_at", threeDaysAgo.toISOString()),
      ]);

      const activeCampaigns = campResult.count || 0;
      const totalContacts = contactResult.count || 0;
      const followUps = followUpResult.count || 0;

      campaignHint = `${activeCampaigns} active`;
      contactHint = `${totalContacts} total`;
      queueHint = followUps > 0 ? `${followUps} follow-ups due` : "all clear";
    } catch {
      // Hints are non-critical
    }

    const action = (await prompts.select({
      message: "What would you like to do?",
      options: [
        {
          value: "campaigns" as const,
          label: "Campaigns",
          hint: campaignHint || "list, create, view details",
        },
        {
          value: "contacts" as const,
          label: "Contacts",
          hint: contactHint || "list, search, view details",
        },
        {
          value: "pitch" as const,
          label: "Pitch",
          hint: "generate AI pitch drafts",
        },
        {
          value: "send" as const,
          label: "Send",
          hint: "send a pitch via Gmail",
        },
        {
          value: "outcome" as const,
          label: "Outcome",
          hint: "log a campaign outcome",
        },
        {
          value: "queue" as const,
          label: "Queue",
          hint: queueHint || "today's action queue",
        },
        {
          value: "discover" as const,
          label: "Discover",
          hint: "find new contacts",
        },
        {
          value: "import" as const,
          label: "Import",
          hint: "import from CSV/JSON",
        },
        {
          value: "stats" as const,
          label: "Stats",
          hint: "workspace statistics",
        },
        {
          value: "watch" as const,
          label: "Watch",
          hint: "live campaign updates",
        },
        { value: "open" as const, label: "Open TAP", hint: "open in browser" },
        { value: "exit" as const, label: "Exit" },
      ],
    })) as string | symbol;

    if (prompts.isCancel(action) || action === "exit") {
      console.log(chalk.dim("  Cheers."));
      blank();
      break;
    }

    switch (action) {
      case "campaigns":
        await campaignsMenu();
        break;
      case "contacts":
        await contactsMenu();
        break;
      case "pitch":
        await runCommand(["pitch"]);
        break;
      case "send":
        await sendMenu();
        break;
      case "outcome":
        await outcomeMenu();
        break;
      case "queue":
        await runCommand(["queue"]);
        break;
      case "discover":
        await discoverMenu();
        break;
      case "import":
        await importMenu();
        break;
      case "stats":
        await runCommand(["stats"]);
        break;
      case "watch":
        await watchMenu();
        break;
      case "open":
        await runCommand(["open"]);
        break;
    }
  }
}

async function campaignsMenu(): Promise<void> {
  while (true) {
    const action = (await prompts.select({
      message: "Campaigns",
      options: [
        { value: "list" as const, label: "List campaigns" },
        { value: "show" as const, label: "Show campaign details" },
        { value: "create" as const, label: "Create campaign" },
        { value: "status" as const, label: "Change status" },
        { value: "back" as const, label: chalk.dim("Back") },
      ],
    })) as string | symbol;

    if (prompts.isCancel(action) || action === "back") return;

    switch (action) {
      case "list": {
        const spinner = out.spinner("Fetching campaigns...");
        try {
          const supabase = getClient();
          const wsId = await resolveWorkspaceId(supabase);

          const { data, error } = await supabase
            .from("tap_projects")
            .select("id, name, artist_name, status")
            .eq("workspace_id", wsId)
            .order("created_at", { ascending: false })
            .limit(20);

          spinner.stop();

          if (error || !data || data.length === 0) {
            if (error) console.log(chalk.red(`  Error: ${error.message}`));
            else console.log(chalk.dim("  No campaigns found"));
            break;
          }

          // Show table first via command
          await runCommand(["campaigns", "list"]);

          // Drill-down loop
          while (true) {
            const drill = (await prompts.select({
              message: "View campaign details?",
              options: [
                ...data.map((c) => ({
                  value: c.id as string,
                  label: `${c.name}${c.artist_name ? ` (${c.artist_name})` : ""}`,
                  hint: c.status,
                })),
                { value: "back" as string, label: chalk.dim("Back") },
              ],
            })) as string | symbol;

            if (prompts.isCancel(drill) || drill === "back") break;

            blank();
            await showCampaign(drill as string, {});

            // Campaign actions via shared helper
            const result = await campaignActionMenu(supabase, wsId, drill as string);
            if (result !== "back") break;
          }
        } catch {
          spinner.stop();
        }
        break;
      }
      case "show": {
        const id = await prompts.text({
          message: "Campaign ID",
          validate: (v) => (!v?.trim() ? "Required" : undefined),
        });
        if (prompts.isCancel(id)) continue;
        blank();
        await showCampaign(id as string, {});
        break;
      }
      case "create": {
        const name = await prompts.text({
          message: "Campaign name",
          validate: (v) => (!v?.trim() ? "Required" : undefined),
        });
        if (prompts.isCancel(name)) continue;

        const artist = await prompts.text({
          message: "Artist name (optional)",
        });
        if (prompts.isCancel(artist)) continue;

        const args = ["campaigns", "create", "--name", name as string];
        if (artist) args.push("--artist", artist as string);
        await runCommand(args);
        break;
      }
      case "status": {
        try {
          const supabase = getClient();
          const wsId = await resolveWorkspaceId(supabase);
          const { selectCampaign } = await import("./actions.js");

          const campaignId = await selectCampaign(supabase, wsId, {
            message: "Which campaign?",
          });
          if (!campaignId) continue;

          const status = await prompts.select({
            message: "New status",
            options: [
              { value: "draft", label: "Draft" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "completed", label: "Completed" },
              { value: "archived", label: "Archived" },
            ],
          });

          if (prompts.isCancel(status)) continue;

          await runCommand(["campaigns", "status", campaignId, status as string]);
        } catch {
          // handled
        }
        break;
      }
    }
  }
}

async function contactsMenu(): Promise<void> {
  while (true) {
    const action = (await prompts.select({
      message: "Contacts",
      options: [
        { value: "list" as const, label: "List contacts" },
        { value: "search" as const, label: "Search contacts" },
        { value: "show" as const, label: "View contact details" },
        { value: "history" as const, label: "Contact history" },
        { value: "add" as const, label: "Add contact" },
        { value: "back" as const, label: chalk.dim("Back") },
      ],
    })) as string | symbol;

    if (prompts.isCancel(action) || action === "back") return;

    switch (action) {
      case "list": {
        const spinner = out.spinner("Fetching contacts...");
        try {
          const supabase = getClient();
          const wsId = await resolveWorkspaceId(supabase);

          const [contactResult, metricsResult] = await Promise.all([
            supabase
              .from("tap_contacts")
              .select("id, name, email, outlet")
              .eq("workspace_id", wsId)
              .order("name", { ascending: true })
              .limit(20),
            supabase
              .from("contact_relationship_metrics")
              .select("contact_id, warmth_level")
              .eq("workspace_id", wsId),
          ]);

          spinner.stop();

          const data = contactResult.data;
          const error = contactResult.error;

          if (error || !data || data.length === 0) {
            if (error) console.log(chalk.red(`  Error: ${error.message}`));
            else console.log(chalk.dim("  No contacts found"));
            break;
          }

          const warmthMap = buildWarmthMap(metricsResult.data);

          await runCommand(["contacts", "list", "--limit", "20"]);

          await contactListDrillDown(data, warmthMap);
        } catch {
          spinner.stop();
        }
        break;
      }
      case "search": {
        const query = await prompts.text({
          message: "Search query",
          placeholder: "e.g. Radio 1, BBC, DJ",
          validate: (v) => (!v?.trim() ? "Required" : undefined),
        });
        if (prompts.isCancel(query)) continue;

        const spinner = out.spinner("Searching...");
        try {
          const supabase = getClient();
          const wsId = await resolveWorkspaceId(supabase);
          const q = (query as string).replace(/'/g, "''");

          const [searchResult, metricsResult] = await Promise.all([
            supabase
              .from("tap_contacts")
              .select("id, name, email, outlet")
              .eq("workspace_id", wsId)
              .or(
                `name.ilike.%${q}%,email.ilike.%${q}%,outlet.ilike.%${q}%,bbc_station.ilike.%${q}%`,
              )
              .order("name", { ascending: true })
              .limit(20),
            supabase
              .from("contact_relationship_metrics")
              .select("contact_id, warmth_level")
              .eq("workspace_id", wsId),
          ]);

          spinner.stop();

          const data = searchResult.data;
          const error = searchResult.error;

          if (error || !data || data.length === 0) {
            if (error) console.log(chalk.red(`  Error: ${error.message}`));
            else console.log(chalk.dim(`  No contacts matching "${query}"`));
            break;
          }

          const warmthMap = buildWarmthMap(metricsResult.data);

          await runCommand(["contacts", "search", query as string]);

          await contactListDrillDown(data, warmthMap);
        } catch {
          spinner.stop();
        }
        break;
      }
      case "show": {
        const idOrEmail = await prompts.text({
          message: "Contact ID or email",
          validate: (v) => (!v?.trim() ? "Required" : undefined),
        });
        if (prompts.isCancel(idOrEmail)) continue;
        blank();
        await showContact(idOrEmail as string, {});
        await contactDrillDown(idOrEmail as string);
        break;
      }
      case "history": {
        const idOrEmail = await prompts.text({
          message: "Contact ID or email",
          validate: (v) => (!v?.trim() ? "Required" : undefined),
        });
        if (prompts.isCancel(idOrEmail)) continue;
        blank();
        await showHistory(idOrEmail as string, {});
        break;
      }
      case "add": {
        const name = await prompts.text({
          message: "Contact name",
          validate: (v) => (!v?.trim() ? "Required" : undefined),
        });
        if (prompts.isCancel(name)) continue;

        const email = await prompts.text({
          message: "Email",
          validate: (v) => {
            if (!v?.trim()) return "Required";
            if (!v.includes("@")) return "Invalid email";
            return undefined;
          },
        });
        if (prompts.isCancel(email)) continue;

        const outlet = await prompts.text({
          message: "Outlet (optional)",
          placeholder: "e.g. BBC Radio 2, NME",
        });
        if (prompts.isCancel(outlet)) continue;

        const args = [
          "contacts",
          "add",
          "--name",
          name as string,
          "--email",
          email as string,
        ];
        if (outlet) args.push("--outlet", outlet as string);
        await runCommand(args);
        break;
      }
    }
  }
}

async function sendMenu(): Promise<void> {
  try {
    const supabase = getClient();
    const wsId = await resolveWorkspaceId(supabase);

    const spinner = out.spinner("Loading unsent drafts...");
    const { data: drafts, error } = await supabase
      .from("campaign_pitch_drafts")
      .select("id, subject, contact_id, campaign_id, created_at")
      .eq("workspace_id", wsId)
      .eq("send_status", "draft")
      .order("created_at", { ascending: false })
      .limit(15);

    spinner.stop();

    if (error || !drafts || drafts.length === 0) {
      out.info("No unsent drafts. Generate a pitch first.");
      return;
    }

    // Resolve contact names
    const contactIds = [...new Set(drafts.map((d) => d.contact_id).filter(Boolean))];
    let contactMap = new Map<string, string>();
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("tap_contacts")
        .select("id, name")
        .in("id", contactIds);
      contactMap = new Map((contacts || []).map((c) => [c.id, c.name || c.id.slice(0, 8)]));
    }

    const selected = await prompts.select({
      message: "Select draft to send",
      options: [
        ...drafts.map((d) => ({
          value: d.id as string,
          label: d.subject || "No subject",
          hint: contactMap.get(d.contact_id) || undefined,
        })),
        { value: "__back__" as string, label: chalk.dim("Cancel") },
      ],
    });

    if (prompts.isCancel(selected) || selected === "__back__") return;

    await runCommand(["send", selected as string]);
  } catch {
    // handled
  }
}

async function outcomeMenu(): Promise<void> {
  try {
    const supabase = getClient();
    const wsId = await resolveWorkspaceId(supabase);
    const { selectCampaign, selectCampaignContact, outcomePrompt: doOutcome } = await import("./actions.js");

    const campaignId = await selectCampaign(supabase, wsId, {
      message: "Which campaign?",
    });
    if (!campaignId) return;

    const contactId = await selectCampaignContact(supabase, campaignId, {
      message: "Which contact?",
    });
    if (!contactId) return;

    blank();
    await doOutcome(supabase, wsId, campaignId, contactId);
  } catch {
    // handled
  }
}

async function discoverMenu(): Promise<void> {
  const query = await prompts.text({
    message: "Search for contacts",
    placeholder: 'e.g. "BBC Radio 6 Music", "dance music London"',
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });

  if (prompts.isCancel(query)) return;

  await runCommand(["discover", query as string]);
}

async function importMenu(): Promise<void> {
  const file = await prompts.text({
    message: "File path (CSV, JSON, or JSONL)",
    placeholder: "e.g. contacts.csv",
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });

  if (prompts.isCancel(file)) return;

  await runCommand(["import", file as string]);
}

async function watchMenu(): Promise<void> {
  try {
    const supabase = getClient();
    const wsId = await resolveWorkspaceId(supabase);

    const mode = await prompts.select({
      message: "Watch mode",
      options: [
        { value: "workspace" as const, label: "Workspace overview" },
        { value: "campaign" as const, label: "Single campaign" },
      ],
    });

    if (prompts.isCancel(mode)) return;

    if (mode === "campaign") {
      const { selectCampaign } = await import("./actions.js");
      const campaignId = await selectCampaign(supabase, wsId, {
        message: "Which campaign to watch?",
      });
      if (!campaignId) return;
      await runCommand(["watch", "--campaign", campaignId]);
    } else {
      await runCommand(["watch"]);
    }
  } catch {
    // handled
  }
}

function buildWarmthMap(metricsData: Array<{ contact_id: string; warmth_level: string | null }> | null): Map<string, string> {
  const map = new Map<string, string>();
  if (metricsData) {
    for (const m of metricsData) {
      if (m.warmth_level) map.set(m.contact_id, m.warmth_level);
    }
  }
  return map;
}

/**
 * Drill-down from a contact list, with warmth hints and action options.
 */
async function contactListDrillDown(
  data: Array<{ id: string; name: string | null; email: string; outlet: string | null }>,
  warmthMap: Map<string, string>,
): Promise<void> {
  while (true) {
    const drill = (await prompts.select({
      message: "View contact details?",
      options: [
        ...data.map((c) => {
          const warmth = warmthMap.get(c.id);
          const hintParts = [c.outlet, warmth].filter(Boolean);
          return {
            value: c.id as string,
            label: c.name || c.email,
            hint: hintParts.join(` ${chalk.dim(GLYPH.dot)} `) || undefined,
          };
        }),
        { value: "back" as string, label: chalk.dim("Back") },
      ],
    })) as string | symbol;

    if (prompts.isCancel(drill) || drill === "back") return;

    blank();
    await showContact(drill as string, {});

    // After viewing, offer actions via shared helper
    await contactDrillDown(drill as string);
  }
}

/**
 * After viewing contact details, offer action options.
 */
async function contactDrillDown(contactId: string): Promise<void> {
  try {
    const supabase = getClient();
    const wsId = await resolveWorkspaceId(supabase);
    await contactActionMenu(supabase, wsId, contactId);
  } catch {
    // Fall back to basic options if auth fails
    const next = (await prompts.select({
      message: "What next?",
      options: [
        { value: "history" as const, label: "View history" },
        { value: "open" as const, label: "Open in TAP" },
        { value: "back" as const, label: chalk.dim("Back") },
      ],
    })) as string | symbol;

    if (prompts.isCancel(next) || next === "back") return;

    if (next === "history") {
      blank();
      await showHistory(contactId, {});
    } else if (next === "open") {
      await runCommand(["open", contactId.slice(0, 8)]);
    }
  }
}

/**
 * Execute a CLI command programmatically by re-parsing args.
 */
async function runCommand(args: string[]): Promise<void> {
  blank();
  try {
    const { buildProgram } = await import("../cli.js");
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    await program.parseAsync(["node", "tap", ...args]);
  } catch {
    // Commander throws on exitOverride -- that's fine
  }
  blank();
}
