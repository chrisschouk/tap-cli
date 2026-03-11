/**
 * CLI output formatting helpers.
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";
import {
  GLYPH,
  CHECK,
  CROSS,
  WARN,
  INFO,
  WARMTH_COLOUR,
  CONFIDENCE_COLOUR,
  PITCH_STATUS_COLOUR,
} from "./ui/theme.js";
import { stripAnsi, ansiPadEnd } from "./ui/detail.js";

/**
 * Create a spinner that writes to stderr so it doesn't pollute --json output.
 */
export function spinner(text: string): Ora {
  return ora({ text, stream: process.stderr }).start();
}

export function table(headers: string[], rows: string[][]): void {
  // Calculate column widths using visible (ANSI-stripped) lengths
  const widths = headers.map((h, i) => {
    const maxRow = Math.max(...rows.map((r) => stripAnsi(r[i] || "").length));
    return Math.max(h.length, maxRow);
  });

  // Print header
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  console.log(`  ${chalk.bold(headerLine)}`);
  console.log(`  ${chalk.dim(GLYPH.divider.repeat(headerLine.length))}`);

  // Print rows
  for (const row of rows) {
    const line = row
      .map((cell, i) => ansiPadEnd(cell || "", widths[i]))
      .join("  ");
    console.log(`  ${line}`);
  }
}

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function success(message: string): void {
  console.log(`  ${CHECK} ${message}`);
}

export function warn(message: string): void {
  console.log(`  ${WARN} ${message}`);
}

export function error(message: string): void {
  console.error(`  ${CROSS} ${message}`);
}

export function info(message: string): void {
  console.log(`  ${INFO} ${message}`);
}

export function statusBadge(status: string): string {
  const colours: Record<string, (s: string) => string> = {
    draft: chalk.dim,
    active: chalk.green,
    paused: chalk.yellow,
    completed: chalk.blue,
    archived: chalk.dim,
  };
  const fn = colours[status] || chalk.white;
  return fn(status);
}

export function confidenceBadge(confidence: string | null): string {
  if (!confidence) return chalk.dim(GLYPH.divider);
  const hex = CONFIDENCE_COLOUR[confidence];
  if (!hex) return chalk.white(confidence);
  return chalk.hex(hex)(confidence);
}

export function truncate(
  str: string | null | undefined,
  maxLen: number,
): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "\u2026";
}

export function warmthBadge(warmth: string | null | undefined): string {
  if (!warmth) return chalk.dim(GLYPH.divider);
  const hex = WARMTH_COLOUR[warmth];
  if (!hex) return chalk.white(warmth);
  return chalk.hex(hex)(warmth);
}

export function pitchStatusBadge(status: string | null | undefined): string {
  if (!status) return chalk.dim(GLYPH.divider);
  const hex = PITCH_STATUS_COLOUR[status];
  const fn = hex ? chalk.hex(hex) : chalk.white;
  return fn(status.replace("_", " "));
}
