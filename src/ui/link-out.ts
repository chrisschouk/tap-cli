/**
 * Commands whose data has no REST v1 endpoint yet. They keep their name so
 * scripts and muscle memory still work, and point at the TAP page instead.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as out from "../output.js";
import { COLOUR } from "./theme.js";
import { blank } from "./format.js";

export interface LinkOut {
  name: string;
  description: string;
  reason: string;
  argument?: { name: string; description: string };
  url: (target?: string) => string;
}

export function linkOutCommand(spec: LinkOut): Command {
  const cmd = new Command(spec.name).description(`${spec.description} (opens in TAP)`);
  if (spec.argument) cmd.argument(`[${spec.argument.name}]`, spec.argument.description);
  return cmd
    .option("--json", "Output as JSON")
    .allowUnknownOption()
    .allowExcessArguments()
    .action((...args: unknown[]) => {
      const self = args[args.length - 1] as Command;
      const url = spec.url(self.processedArgs[0] as string | undefined);
      if (self.opts().json) {
        out.json({ available: false, reason: spec.reason, url });
        return;
      }
      blank();
      out.info(spec.reason);
      console.log(`  ${chalk.hex(COLOUR.primary)(url)}`);
      blank();
    });
}
