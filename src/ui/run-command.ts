/**
 * Shared helper: execute a CLI command programmatically by re-parsing args.
 *
 * Interactive mode runs commands in-process, and commands end a failed run
 * with `process.exit(1)`. While a command runs here, `process.exit` throws
 * CommandExit instead, so a failure returns to the menu.
 */

import chalk from "chalk";
import { blank } from "./format.js";
import { CommandExit } from "./errors.js";

export async function runCommand(args: string[]): Promise<void> {
  blank();
  const realExit = process.exit;
  process.exit = ((code?: number) => {
    throw new CommandExit(code ?? 0);
  }) as typeof process.exit;
  try {
    const { buildProgram } = await import("../program.js");
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    await program.parseAsync(["node", "tap", ...args]);
  } catch (err) {
    reportUnexpected(err);
  } finally {
    process.exit = realExit;
  }
  blank();
}

function reportUnexpected(err: unknown): void {
  if (err instanceof CommandExit) return;
  if ((err as { exitCode?: number })?.exitCode !== undefined) return; // Commander exit
  if (err instanceof Error && err.message) console.error(chalk.red(err.message));
}
