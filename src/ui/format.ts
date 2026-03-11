/**
 * TUI formatting: logo, step indicators, dividers.
 *
 * Same pattern as sink-cli/src/ui/format.ts.
 */

import chalk from "chalk";
import ora from "ora";
import { GLYPH, COLOUR } from "./theme.js";

// -- Glyphs (pre-coloured) ---------------------------------------------------
const DIAMOND = chalk.hex(COLOUR.primary)(GLYPH.diamond);

// -- Logo ---------------------------------------------------------------------
export const LOGO_LINES = [
  "   __              ",
  "  / /_ ___ _ ___   ",
  "  \\__/\\__,|/ __ \\  ",
  "       |__/  /_/ / ",
  "          / .___/  ",
  "         /_/       ",
];

// -- Exports ------------------------------------------------------------------

export function intro(version: string): void {
  console.log("");
  for (let i = 0; i < LOGO_LINES.length; i++) {
    if (i === 1) {
      console.log(
        `${chalk.hex(COLOUR.primary)(LOGO_LINES[i])}  ${chalk.dim(`v${version}`)}`,
      );
    } else {
      console.log(chalk.hex(COLOUR.primary)(LOGO_LINES[i]));
    }
  }
  console.log(chalk.dim("  Total Audio Platform CLI"));
  console.log("");
}

export function step(message: string): void {
  console.log(`  ${message}`);
}

export function stepComplete(message: string): void {
  console.log(`  ${DIAMOND} ${message}`);
}

export function blank(): void {
  console.log("");
}

export function divider(): void {
  console.log(chalk.dim(`  ${GLYPH.divider.repeat(44)}`));
}

export function heading(text: string): void {
  console.log(`  ${chalk.bold(text)}`);
}

export function outro(message?: string): void {
  if (message) {
    console.log(`  ${chalk.dim(message)}`);
  }
  console.log("");
}

/**
 * Spinner that sits inside the rail.
 * Call .succeed(text) to replace with a diamond checkpoint.
 */
export function createRailSpinner(text: string) {
  const spinner = ora({
    text,
    prefixText: " ",
    spinner: "dots",
  });
  return {
    start() {
      spinner.start();
      return this;
    },
    succeed(msg: string) {
      spinner.stop();
      stepComplete(msg);
    },
    fail(msg: string) {
      spinner.stop();
      console.log(`  ${chalk.red(GLYPH.cross)} ${msg}`);
    },
    stop() {
      spinner.stop();
    },
  };
}
