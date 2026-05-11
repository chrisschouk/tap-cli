/**
 * Shared helper: execute a CLI command programmatically by re-parsing args.
 *
 * Wraps the buildProgram() + exitOverride() + parseAsync() trampoline so
 * callers do not repeat the same try/catch boilerplate.
 */

import chalk from "chalk";
import { blank } from "./format.js";

export async function runCommand(args: string[]): Promise<void> {
  blank();
  try {
    const { buildProgram } = await import("../cli.js");
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    await program.parseAsync(["node", "tap", ...args]);
  } catch (err: any) {
    if (err?.exitCode !== undefined) return; // Commander exit
    if (err instanceof Error && err.message) {
      console.error(chalk.red(err.message));
    }
  }
  blank();
}
