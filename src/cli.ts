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

import chalk from "chalk";
import { intro } from "./ui/format.js";
import { buildProgram, VERSION } from "./program.js";
import { interrupt } from "./ui/interrupt.js";

// chalk ignores NO_COLOR (https://no-color.org); honour it here.
if (process.env.NO_COLOR) chalk.level = 0;

// A closed terminal makes writes fail; the SIGHUP handler still has to withdraw an open request.
process.on("SIGHUP", () => {
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, interrupt);

// Handle --version/-v before Commander
const hasVersionFlag = process.argv.includes("--version") || process.argv.includes("-v");

if (hasVersionFlag) {
  intro(VERSION);
  process.exit(0);
}

// Interactive mode: bare `tap` with no args
const isInteractive = process.argv.length <= 2;

if (isInteractive) {
  // Dynamic import to avoid loading Commander for interactive
  import("./ui/interactive.js").then(({ runInteractive }) => runInteractive());
} else {
  const program = buildProgram();
  program.parse();
}
