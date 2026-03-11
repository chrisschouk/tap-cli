/**
 * Interactive mode -- bare `tap` launches a guided menu.
 *
 * Loops through main menu until user selects Exit or presses Ctrl+C.
 */

import * as prompts from "@clack/prompts";
import chalk from "chalk";
import { intro, blank } from "./format.js";

const VERSION = "0.2.0";

export async function runInteractive(): Promise<void> {
  intro(VERSION);

  // eslint-disable-next-line no-constant-condition
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
          hint: "list, search, add",
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
    case "list":
      await runCommand(["campaigns", "list"]);
      break;
    case "show": {
      const id = await prompts.text({
        message: "Campaign ID",
        validate: (v) => (!v?.trim() ? "Required" : undefined),
      });
      if (prompts.isCancel(id)) return;
      await runCommand(["campaigns", "show", id as string]);
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
      { value: "add" as const, label: "Add contact" },
      { value: "back" as const, label: chalk.dim("Back") },
    ],
  })) as string | symbol;

  if (prompts.isCancel(action) || action === "back") return;

  switch (action) {
    case "list":
      await runCommand(["contacts", "list"]);
      break;
    case "search": {
      const query = await prompts.text({
        message: "Search query",
        placeholder: "e.g. Radio 1, BBC, DJ",
        validate: (v) => (!v?.trim() ? "Required" : undefined),
      });
      if (prompts.isCancel(query)) return;
      await runCommand(["contacts", "search", query as string]);
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
 * Execute a CLI command programmatically by re-parsing args.
 */
async function runCommand(args: string[]): Promise<void> {
  blank();
  try {
    const { Command } = await import("commander");
    const { campaignsCommand } = await import("../commands/campaigns.js");
    const { contactsCommand } = await import("../commands/contacts.js");
    const { queueCommand } = await import("../commands/queue.js");
    const { statsCommand } = await import("../commands/stats.js");
    const { outcomeCommand } = await import("../commands/outcome.js");
    const { pitchCommand } = await import("../commands/pitch.js");
    const { openCommand } = await import("../commands/open.js");

    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
    });

    program.addCommand(campaignsCommand());
    program.addCommand(contactsCommand());
    program.addCommand(outcomeCommand());
    program.addCommand(pitchCommand());
    program.addCommand(openCommand());
    program.addCommand(queueCommand());
    program.addCommand(statsCommand());

    await program.parseAsync(["node", "tap", ...args]);
  } catch {
    // Commander throws on exitOverride -- that's fine
  }
  blank();
}
