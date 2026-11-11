/**
 * Action queue command for the TAP CLI.
 *
 * Shows TAP's prioritised actions (the same list as the Home page): follow-ups
 * due, unread replies, stalled campaigns, contacts going cold, coverage to log.
 */

import { Command } from "commander";
import chalk from "chalk";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import { GLYPH } from "../ui/theme.js";
import { navHint } from "../ui/detail.js";
import { handleError } from "../ui/errors.js";
import { blank } from "../ui/format.js";

type Priority = "urgent" | "attention" | "info";

interface QueueAction {
  type: string;
  priority: Priority;
  entity_name: string;
  entity_id: string;
  reason: string;
  action_url: string;
}

const PRIORITY_SECTIONS: Array<{ priority: Priority; title: string; badge: string }> = [
  { priority: "urgent", title: "Needs you today", badge: chalk.red.bold("HIGH") },
  { priority: "attention", title: "Worth a look", badge: chalk.yellow("MEDIUM") },
  { priority: "info", title: "For information", badge: chalk.dim("LOW") },
];

function renderSection(title: string, badge: string, actions: QueueAction[]): void {
  const heading = `${title} (${actions.length})`;
  console.log("");
  console.log(`  ${chalk.bold(heading)}${" ".repeat(Math.max(1, 46 - heading.length))}${badge}`);
  console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));
  for (const a of actions) {
    console.log(`  ${chalk.dim(GLYPH.dot)} ${a.entity_name}  ${chalk.dim(a.reason)}`);
  }
}

export function queueCommand(): Command {
  return new Command("queue")
    .description("Show today's action queue")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const spinner = out.spinner("Loading action queue...");

      try {
        const res = await restRequest<{ actions: QueueAction[] }>("/api/v1/actions");
        spinner.stop();

        if (opts.json) {
          out.json(res);
          return;
        }

        console.log("");
        console.log(
          `  ${chalk.bold("Action Queue")} ${chalk.dim(GLYPH.divider + GLYPH.divider)} ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`,
        );
        console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));

        for (const section of PRIORITY_SECTIONS) {
          const actions = res.actions.filter((a) => a.priority === section.priority);
          if (actions.length > 0) renderSection(section.title, section.badge, actions);
        }

        if (res.actions.length === 0) {
          out.success("Queue is clear. Nice work.");
        }

        navHint(["tap campaigns show <id>"]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });
}
