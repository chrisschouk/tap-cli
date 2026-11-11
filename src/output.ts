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
  return ora({ text, prefixText: " ", stream: process.stderr }).start();
}

/** Shrink the widest columns until the row fits the terminal, keeping each at least 6 wide. */
function fitWidths(widths: number[], available: number): number[] {
  const fitted = [...widths];
  const gaps = 2 * (fitted.length - 1);
  while (fitted.reduce((a, b) => a + b, 0) + gaps > available) {
    const widest = fitted.indexOf(Math.max(...fitted));
    if (fitted[widest] <= 6) break;
    fitted[widest]--;
  }
  return fitted;
}

/** Plain cells are cut to fit with an ellipsis; coloured badges are short and left alone. */
function fitCell(cell: string, width: number): string {
  return stripAnsi(cell) === cell ? truncate(cell, width) : cell;
}

export function table(headers: string[], rows: string[][]): void {
  const natural = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] || "").length)),
  );
  const widths = fitWidths(natural, (process.stdout.columns || 120) - 2);

  const headerLine = headers.map((h, i) => truncate(h, widths[i]).padEnd(widths[i])).join("  ");
  console.log(`  ${chalk.bold(headerLine)}`);
  console.log(`  ${chalk.dim(GLYPH.divider.repeat(headerLine.length))}`);

  for (const row of rows) {
    const line = row.map((cell, i) => ansiPadEnd(fitCell(cell || "", widths[i]), widths[i])).join("  ");
    console.log(`  ${line.trimEnd()}`);
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
