/**
 * Shared detail rendering primitives for rich CLI views.
 *
 * Used by contacts show, campaigns show, history, and other detail views.
 */

import chalk from "chalk";
import { GLYPH, WARMTH_COLOUR } from "./theme.js";

const LABEL_WIDTH = 18;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Strip ANSI escape codes to get the visible length of a string.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

/**
 * ANSI-aware padEnd -- pads based on visible character count, not raw string length.
 */
export function ansiPadEnd(str: string, width: number): string {
  const visible = stripAnsi(str).length;
  const pad = Math.max(0, width - visible);
  return str + " ".repeat(pad);
}

/**
 * Render a label: value pair with consistent padding.
 * Null/undefined values render as a dim dash.
 */
export function field(
  label: string,
  value: string | number | null | undefined,
  opts?: { colour?: (s: string) => string },
): string {
  const paddedLabel = chalk.dim(label.padEnd(LABEL_WIDTH));
  if (value === null || value === undefined || value === "") {
    return `  ${paddedLabel}${chalk.dim(GLYPH.divider)}`;
  }
  const str = String(value);
  const coloured = opts?.colour ? opts.colour(str) : str;
  return `  ${paddedLabel}${coloured}`;
}

/**
 * Render a label with a comma-joined list of items.
 */
export function fieldList(
  label: string,
  items: string[] | null | undefined,
): string {
  if (!items || items.length === 0) {
    return field(label, null);
  }
  return field(label, items.join(", "));
}

/**
 * Section header: bold title left, optional dim meta right, then divider.
 */
export function sectionHeader(title: string, meta?: string): void {
  console.log("");
  if (meta) {
    console.log(`  ${chalk.bold(title)}${" ".repeat(Math.max(1, 52 - title.length - meta.length))}${chalk.dim(meta)}`);
  } else {
    console.log(`  ${chalk.bold(title)}`);
  }
  console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));
}

/**
 * Warning block: yellow `!` prefix per line.
 */
export function warningBlock(lines: string[]): void {
  console.log("");
  for (const line of lines) {
    console.log(`  ${chalk.yellow("!")} ${line}`);
  }
}

/**
 * Visual bar using block characters.
 * ratio is 0-1, width is number of characters.
 */
export function sparkbar(ratio: number, width = 16): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return `${GLYPH.blockFull.repeat(filled)}${chalk.dim(GLYPH.blockLight.repeat(empty))}`;
}

/**
 * Relative date string: "3d ago", "2w ago", "3mo ago", "1y ago".
 */
export function relativeDate(isoDate: string | null | undefined): string {
  if (!isoDate) return chalk.dim(GLYPH.divider);

  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays < 0) {
    // Future date
    const absDays = Math.abs(diffDays);
    if (absDays === 1) return "tomorrow";
    if (absDays < 7) return `in ${absDays}d`;
    if (absDays < 30) return `in ${Math.floor(absDays / 7)}w`;
    return `in ${Math.floor(absDays / 30)}mo`;
  }

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "1d ago";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

/**
 * Colour-coded percentage string.
 * Green >50%, yellow 20-50%, red <20%.
 */
export function percentage(n: number | null | undefined): string {
  if (n === null || n === undefined) return chalk.dim(GLYPH.divider);
  const pct = Math.round(n * 100);
  const str = `${pct}%`;
  if (pct >= 50) return chalk.green(str);
  if (pct >= 20) return chalk.yellow(str);
  return chalk.red(str);
}

/**
 * Colour-coded warmth label.
 */
export function warmthColour(level: string | null | undefined): (s: string) => string {
  const hex = WARMTH_COLOUR[level || ""];
  if (!hex) return chalk.dim;
  return chalk.hex(hex);
}

/**
 * Navigation hint at the bottom of detail views.
 */
export function navHint(hints: string[]): void {
  console.log("");
  console.log(`  ${chalk.dim(hints.join("  " + GLYPH.dot + "  "))}`);
}

/**
 * Format a date as "12 Mar" or "12 Mar 2025" (if different year).
 */
export function shortDate(isoDate: string | null | undefined): string {
  if (!isoDate) return chalk.dim(GLYPH.divider);
  const d = new Date(isoDate);
  const now = new Date();
  const day = d.getDate();
  const month = d.toLocaleDateString("en-GB", { month: "short" });
  if (d.getFullYear() !== now.getFullYear()) {
    return `${day} ${month} ${d.getFullYear()}`;
  }
  return `${day} ${month}`;
}
