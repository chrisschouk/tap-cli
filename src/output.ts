/**
 * CLI output formatting helpers.
 */

import chalk from "chalk";
import { GLYPH, COLOUR } from "./ui/theme.js";

export function table(headers: string[], rows: string[][]): void {
  // Calculate column widths
  const widths = headers.map((h, i) => {
    const maxRow = Math.max(...rows.map((r) => (r[i] || "").length));
    return Math.max(h.length, maxRow);
  });

  // Print header
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  console.log(chalk.bold(headerLine));
  console.log(chalk.dim(GLYPH.divider.repeat(headerLine.length)));

  // Print rows
  for (const row of rows) {
    const line = row
      .map((cell, i) => (cell || "").padEnd(widths[i]))
      .join("  ");
    console.log(line);
  }
}

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function success(message: string): void {
  console.log(chalk.green(GLYPH.check), message);
}

export function warn(message: string): void {
  console.log(chalk.yellow("!"), message);
}

export function error(message: string): void {
  console.error(chalk.red(GLYPH.cross), message);
}

export function info(message: string): void {
  console.log(chalk.hex(COLOUR.primary)("i"), message);
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
  const colours: Record<string, (s: string) => string> = {
    High: chalk.green,
    Medium: chalk.yellow,
    Low: chalk.red,
  };
  const fn = colours[confidence] || chalk.white;
  return fn(confidence);
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
  const colours: Record<string, (s: string) => string> = {
    hot: chalk.red,
    warm: chalk.yellow,
    neutral: chalk.white,
    cold: chalk.blue,
    over_pitched: chalk.hex(COLOUR.warning),
  };
  const fn = colours[warmth] || chalk.white;
  return fn(warmth);
}

export function pitchStatusBadge(status: string | null | undefined): string {
  if (!status) return chalk.dim(GLYPH.divider);
  const colours: Record<string, (s: string) => string> = {
    not_pitched: chalk.dim,
    sent: chalk.hex(COLOUR.primary),
    opened: chalk.blue,
    replied: chalk.green,
    declined: chalk.red,
    bounced: chalk.red,
  };
  const fn = colours[status] || chalk.white;
  return fn(status.replace("_", " "));
}
