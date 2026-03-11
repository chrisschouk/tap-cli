#!/usr/bin/env node

/**
 * TAP CLI -- Terminal interface for Total Audio Platform.
 *
 * Usage:
 *   tap                          (interactive mode)
 *   tap campaigns list
 *   tap campaigns show <id>
 *   tap contacts search "Radio 1"
 *   tap contacts add --name "..." --email "..."
 *   tap pitch <campaign-id>
 *   tap outcome <campaign-id> <contact-id> <type>
 *   tap queue
 *   tap stats
 *   tap open [id]
 */

import { Command } from "commander";
import { campaignsCommand } from "./commands/campaigns.js";
import { contactsCommand } from "./commands/contacts.js";
import { queueCommand } from "./commands/queue.js";
import { statsCommand } from "./commands/stats.js";
import { authCommand } from "./commands/auth.js";
import { outcomeCommand } from "./commands/outcome.js";
import { pitchCommand } from "./commands/pitch.js";
import { openCommand } from "./commands/open.js";
import { intro } from "./ui/format.js";

export const VERSION = "0.2.0";

// Interactive mode: bare `tap` with no args
const isInteractive = process.argv.length <= 2;

if (isInteractive) {
  // Dynamic import to avoid loading Commander for interactive
  import("./ui/interactive.js").then(({ runInteractive }) => runInteractive());
} else {
  const program = new Command();

  program
    .name("tap")
    .description(
      "Total Audio Platform CLI -- manage campaigns, contacts, and pitches from the terminal",
    )
    .version(VERSION, "-v, --version");

  // Show logo on --version
  program.on("option:version", () => {
    intro(VERSION);
    process.exit(0);
  });

  program.addCommand(authCommand());
  program.addCommand(campaignsCommand());
  program.addCommand(contactsCommand());
  program.addCommand(outcomeCommand());
  program.addCommand(pitchCommand());
  program.addCommand(openCommand());
  program.addCommand(queueCommand());
  program.addCommand(statsCommand());

  program.parse();
}
