/**
 * The Commander program, kept apart from the `cli.ts` entry point so
 * interactive mode can build it without re-running the entry's side effects.
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
import { sendCommand } from "./commands/send.js";
import { discoverCommand } from "./commands/discover.js";
import { importCommand } from "./commands/import.js";
import { watchCommand } from "./commands/watch.js";
import { skillCommand } from "./commands/skill.js";
import { mcpCommand, connectCommand } from "./commands/mcp.js";
import { doctorCommand } from "./commands/doctor.js";

export const VERSION = "0.5.0";

/**
 * Build the Commander program with all commands registered.
 * Shared by both direct CLI invocation and interactive mode.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("tap")
    .description(
      "Total Audio Platform CLI -- manage campaigns, contacts, and pitches from the terminal",
    )
    .version(VERSION, "-v, --version");

  program.addCommand(authCommand());
  program.addCommand(campaignsCommand());
  program.addCommand(connectCommand());
  program.addCommand(contactsCommand());
  program.addCommand(discoverCommand());
  program.addCommand(doctorCommand());
  program.addCommand(importCommand());
  program.addCommand(mcpCommand());
  program.addCommand(outcomeCommand());
  program.addCommand(pitchCommand());
  program.addCommand(openCommand());
  program.addCommand(queueCommand());
  program.addCommand(sendCommand());
  program.addCommand(skillCommand());
  program.addCommand(statsCommand());
  program.addCommand(watchCommand());

  return program;
}
