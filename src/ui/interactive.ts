/**
 * Interactive mode -- bare `tap` launches a guided menu.
 *
 * Loops through main menu until user selects Exit or presses Ctrl+C.
 * Supports drill-down from list views into detail views.
 */

import * as prompts from "@clack/prompts";
import chalk from "chalk";
import ora from "ora";
import { intro, blank } from "./format.js";
import { VERSION } from "../cli.js";
import { getClient, resolveWorkspaceId } from "../auth.js";
import { showContact, showHistory } from "../commands/contacts.js";
import { showCampaign } from "../commands/campaigns.js";

export async function runInteractive(): Promise<void> {
  intro(VERSION);

  while (true) {
    const action = (await prompts.select({
      message: "What would you like to do?",
      options: [
        {
          value: "campaigns" as const,
          label: "Campaigns",
          hint: "list, create, view details",
        },
        {
          value: "contacts" as const,
          label: "Contacts",
          hint: "list, search, view details, history",
        },
        {
          value: "pitch" as const,
          label: "Pitch",
          hint: "generate AI pitch drafts",
        },
        {
          value: "queue" as const,
          label: "Queue",
          hint: "today's action queue",
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
      // Fetch campaigns and offer drill-down
      const spinner = ora("Fetching campaigns...").start();
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

        // Offer drill-down
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

        if (!prompts.isCancel(drill) && drill !== "back") {
          blank();
          await showCampaign(drill as string, {});
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
      if (prompts.isCancel(id)) return;
      blank();
      await showCampaign(id as string, {});
      break;
    }
    case "create": {
      const name = await prompts.text({
        message: "Campaign name",
        validate: (v) => (!v?.trim() ? "Required" : undefined),
      });
      if (prompts.isCancel(name)) return;

      const artist = await prompts.text({
        message: "Artist name (optional)",
      });
      if (prompts.isCancel(artist)) return;

      const args = ["campaigns", "create", "--name", name as string];
      if (artist) args.push("--artist", artist as string);
      await runCommand(args);
      break;
    }
  }
}

async function contactsMenu(): Promise<void> {
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
      // Fetch contacts and offer drill-down
      const spinner = ora("Fetching contacts...").start();
      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase);

        const { data, error } = await supabase
          .from("tap_contacts")
          .select("id, name, email, outlet")
          .eq("workspace_id", wsId)
          .order("name", { ascending: true })
          .limit(20);

        spinner.stop();

        if (error || !data || data.length === 0) {
          if (error) console.log(chalk.red(`  Error: ${error.message}`));
          else console.log(chalk.dim("  No contacts found"));
          break;
        }

        // Show table first via command
        await runCommand(["contacts", "list", "--limit", "20"]);

        // Offer drill-down
        const drill = (await prompts.select({
          message: "View contact details?",
          options: [
            ...data.map((c) => ({
              value: c.id as string,
              label: c.name || c.email,
              hint: c.outlet || undefined,
            })),
            { value: "back" as string, label: chalk.dim("Back") },
          ],
        })) as string | symbol;

        if (!prompts.isCancel(drill) && drill !== "back") {
          blank();
          await showContact(drill as string, {});

          // After viewing, offer next action
          await contactDrillDown(drill as string);
        }
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
      if (prompts.isCancel(query)) return;

      // Fetch results for drill-down
      const spinner = ora("Searching...").start();
      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase);
        const q = (query as string).replace(/'/g, "''");

        const { data, error } = await supabase
          .from("tap_contacts")
          .select("id, name, email, outlet")
          .eq("workspace_id", wsId)
          .or(
            `name.ilike.%${q}%,email.ilike.%${q}%,outlet.ilike.%${q}%,bbc_station.ilike.%${q}%`,
          )
          .order("name", { ascending: true })
          .limit(20);

        spinner.stop();

        if (error || !data || data.length === 0) {
          if (error) console.log(chalk.red(`  Error: ${error.message}`));
          else console.log(chalk.dim(`  No contacts matching "${query}"`));
          break;
        }

        // Show table
        await runCommand(["contacts", "search", query as string]);

        // Offer drill-down
        const drill = (await prompts.select({
          message: "View contact details?",
          options: [
            ...data.map((c) => ({
              value: c.id as string,
              label: c.name || c.email,
              hint: c.outlet || undefined,
            })),
            { value: "back" as string, label: chalk.dim("Back") },
          ],
        })) as string | symbol;

        if (!prompts.isCancel(drill) && drill !== "back") {
          blank();
          await showContact(drill as string, {});
          await contactDrillDown(drill as string);
        }
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
      if (prompts.isCancel(idOrEmail)) return;
      blank();
      await showContact(idOrEmail as string, {});
      break;
    }
    case "history": {
      const idOrEmail = await prompts.text({
        message: "Contact ID or email",
        validate: (v) => (!v?.trim() ? "Required" : undefined),
      });
      if (prompts.isCancel(idOrEmail)) return;
      blank();
      await showHistory(idOrEmail as string, {});
      break;
    }
    case "add": {
      const name = await prompts.text({
        message: "Contact name",
        validate: (v) => (!v?.trim() ? "Required" : undefined),
      });
      if (prompts.isCancel(name)) return;

      const email = await prompts.text({
        message: "Email",
        validate: (v) => {
          if (!v?.trim()) return "Required";
          if (!v.includes("@")) return "Invalid email";
          return undefined;
        },
      });
      if (prompts.isCancel(email)) return;

      const outlet = await prompts.text({
        message: "Outlet (optional)",
        placeholder: "e.g. BBC Radio 2, NME",
      });
      if (prompts.isCancel(outlet)) return;

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

/**
 * After viewing contact details, offer next actions.
 */
async function contactDrillDown(contactId: string): Promise<void> {
  const next = (await prompts.select({
    message: "What next?",
    options: [
      { value: "history" as const, label: "View history" },
      { value: "back" as const, label: chalk.dim("Back") },
    ],
  })) as string | symbol;

  if (prompts.isCancel(next) || next === "back") return;

  if (next === "history") {
    blank();
    await showHistory(contactId, {});
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
