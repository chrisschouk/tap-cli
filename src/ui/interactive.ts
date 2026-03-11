/**
 * Interactive mode -- bare `tap` launches a guided menu.
 *
 * Loops through main menu until user selects Exit or presses Ctrl+C.
 * Supports drill-down from list views into detail views with back navigation.
 */

import * as prompts from "@clack/prompts";
import chalk from "chalk";
import { intro, blank } from "./format.js";
import { GLYPH, COLOUR } from "./theme.js";
import { VERSION } from "../cli.js";
import { getClient, resolveWorkspaceId } from "../auth.js";
import { showContact, showHistory } from "../commands/contacts.js";
import { showCampaign } from "../commands/campaigns.js";
import * as out from "../output.js";

export async function runInteractive(): Promise<void> {
  intro(VERSION);

  while (true) {
    // Fetch live hints in parallel
    let campaignHint = "";
    let contactHint = "";
    let queueHint = "";

    try {
      const supabase = getClient();
      const wsId = await resolveWorkspaceId(supabase);

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
        (() => {
          const threeDaysAgo = new Date();
          threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
          return supabase
            .from("campaign_contacts")
            .select("contact_id", { count: "exact", head: true })
            .eq("pitch_status", "sent")
            .lt("last_pitched_at", threeDaysAgo.toISOString());
        })(),
      ]);

      const activeCampaigns = campResult.count || 0;
      const totalContacts = contactResult.count || 0;
      const followUps = followUpResult.count || 0;

      campaignHint = `${activeCampaigns} active`;
      contactHint = `${totalContacts} total`;
      queueHint = followUps > 0 ? `${followUps} follow-ups due` : "all clear";
    } catch {
      // Hints are non-critical, continue without them
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
          value: "queue" as const,
          label: "Queue",
          hint: queueHint || "today's action queue",
        },
        {
          value: "stats" as const,
          label: "Stats",
          hint: "workspace statistics",
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
      case "queue":
        await runCommand(["queue"]);
        break;
      case "stats":
        await runCommand(["stats"]);
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

            // Campaign drill-down actions
            const next = (await prompts.select({
              message: "What next?",
              options: [
                { value: "contacts" as const, label: "View contacts" },
                { value: "open" as const, label: "Open in TAP" },
                { value: "back" as const, label: chalk.dim("Back to list") },
              ],
            })) as string | symbol;

            if (prompts.isCancel(next) || next === "back") continue;

            if (next === "contacts") {
              await runCommand(["campaigns", "show", drill as string]);
            } else if (next === "open") {
              await runCommand(["open", (drill as string).slice(0, 8)]);
            }
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

        // Drill-down after manual show
        const next = (await prompts.select({
          message: "What next?",
          options: [
            { value: "open" as const, label: "Open in TAP" },
            { value: "back" as const, label: chalk.dim("Back") },
          ],
        })) as string | symbol;

        if (!prompts.isCancel(next) && next === "open") {
          await runCommand(["open", (id as string).slice(0, 8)]);
        }
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

          // Fetch contacts with warmth for hints
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

          // Build warmth lookup
          const warmthMap = new Map<string, string>();
          if (metricsResult.data) {
            for (const m of metricsResult.data) {
              if (m.warmth_level) warmthMap.set(m.contact_id, m.warmth_level);
            }
          }

          // Show table first
          await runCommand(["contacts", "list", "--limit", "20"]);

          // Drill-down loop
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

          // Build warmth lookup
          const warmthMap = new Map<string, string>();
          if (metricsResult.data) {
            for (const m of metricsResult.data) {
              if (m.warmth_level) warmthMap.set(m.contact_id, m.warmth_level);
            }
          }

          // Show table
          await runCommand(["contacts", "search", query as string]);

          // Drill-down loop
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

/**
 * Drill-down from a contact list, with warmth hints and back-to-list navigation.
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

    // After viewing, offer next actions -- then return to list
    await contactDrillDown(drill as string);
  }
}

/**
 * After viewing contact details, offer next actions.
 */
async function contactDrillDown(contactId: string): Promise<void> {
  const next = (await prompts.select({
    message: "What next?",
    options: [
      { value: "history" as const, label: "View history" },
      { value: "open" as const, label: "Open in TAP" },
      { value: "back" as const, label: chalk.dim("Back to list") },
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
