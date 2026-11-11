/**
 * TUI formatting: banner, step indicators, dividers, summary.
 *
 * Mole-inspired aesthetic: clean header, checkmark trails,
 * summary bars with double-line separators, navigation hints.
 */

import chalk from "chalk";
import ora from "ora";
import { GLYPH, COLOUR } from "./theme.js";

// -- Glyphs (pre-coloured) ---------------------------------------------------
const DIAMOND = chalk.hex(COLOUR.primary)(GLYPH.diamond);
const SEPARATOR = "\u2550"; // ═ (double-line)

/** Visible terminal width, or 80 when stdout is not a terminal. */
function terminalWidth(): number {
  return process.stdout.columns || 80;
}

/** Rules and bars run 52 columns, or less on a narrow terminal. */
function ruleWidth(): number {
  return Math.max(16, Math.min(52, terminalWidth() - 4));
}

// -- Logo ---------------------------------------------------------------------

const LOGO_LINES = [
  "   __",
  "  / /____ ____",
  " / __/ _ `/ _ \\",
  " \\__/\\_,_/ .__/",
  "        /_/",
];

/** Top to bottom, the logo cools from TAP cyan to a deeper teal. */
const LOGO_SHADES = ["#22d3ee", "#06b6d4", "#0aa5c0", "#0891b2", "#0e7490"];

const LOGO_WIDTH = Math.max(...LOGO_LINES.map((l) => l.length));
const BOX_WIDTH = 60;
const H = "\u2500"; // ─
const TL = "\u256D"; // ╭
const TR = "\u256E"; // ╮
const BL = "\u2570"; // ╰
const BR = "\u256F"; // ╯
const V = "\u2502"; // │

const border = chalk.hex(COLOUR.primary).dim;

export interface WorkspaceHints {
  contacts: number;
  campaigns: number;
  followUps: number;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `230 contacts · 1 active campaign · queue clear`, as [coloured, plain]. */
function contextBar(hints: WorkspaceHints): [string, string] {
  const accent = chalk.hex(COLOUR.primary);
  const contacts = plural(hints.contacts, "contact", "contacts");
  const campaigns = plural(hints.campaigns, "active campaign", "active campaigns");
  const queue = hints.followUps > 0 ? plural(hints.followUps, "follow-up due", "follow-ups due") : "queue clear";
  const sep = `  ${GLYPH.dot}  `;
  const colour = (s: string, n: number, c = accent) => s.replace(String(n), c(String(n)));
  const coloured = [
    colour(contacts, hints.contacts),
    colour(campaigns, hints.campaigns),
    hints.followUps > 0 ? colour(queue, hints.followUps, chalk.hex(COLOUR.warning)) : chalk.dim(queue),
  ].join(chalk.dim(sep));
  return [coloured, [contacts, campaigns, queue].join(sep)];
}

/** The banner's lines as [coloured, plain] pairs, before any box is drawn. */
function bannerLines(version: string, hints?: WorkspaceHints): Array<[string, string]> {
  const side: Record<number, [string, string]> = {
    2: [chalk.bold(`v${version}`), `v${version}`],
    3: [chalk.dim("Total Audio Platform CLI"), "Total Audio Platform CLI"],
  };
  const lines: Array<[string, string]> = LOGO_LINES.map((art, i) => {
    const padded = art.padEnd(LOGO_WIDTH + 4);
    const [sideColoured, sidePlain] = side[i] ?? ["", ""];
    return [chalk.hex(LOGO_SHADES[i]).bold(padded) + sideColoured, padded + sidePlain];
  });
  if (hints) lines.push(["", ""], contextBar(hints));
  return lines;
}

function boxed(lines: Array<[string, string]>): string[] {
  const inner = BOX_WIDTH - 2;
  const row = ([coloured, plain]: [string, string]) =>
    `  ${border(V)}   ${coloured}${" ".repeat(Math.max(0, inner - 3 - plain.length))}${border(V)}`;
  const blankRow: [string, string] = ["", ""];
  return [
    `  ${border(TL + H.repeat(inner) + TR)}`,
    row(blankRow),
    ...lines.map(row),
    row(blankRow),
    `  ${border(BL + H.repeat(inner) + BR)}`,
  ];
}

/**
 * The TAP banner: the logo in a rounded box, with live workspace counts when
 * interactive mode has them. Below 64 columns the box would wrap, so the
 * same lines print unboxed.
 */
export function intro(version: string, opts?: { contextBar?: WorkspaceHints }): void {
  const lines = bannerLines(version, opts?.contextBar);
  const rendered = terminalWidth() >= BOX_WIDTH + 4 ? boxed(lines) : lines.map(([c]) => `  ${c}`);
  console.log(["", ...rendered, ""].join("\n"));
}

// -- Steps & checkpoints ------------------------------------------------------

const STEP_LABEL_WIDTH = 12;

/** A finished step on the rail: `◇ Imported     12 new, 3 already in TAP`. */
export function stepComplete(label: string, detail?: string): void {
  const text = detail ? `${label.padEnd(STEP_LABEL_WIDTH)} ${chalk.dim(detail)}` : label;
  console.log(`  ${DIAMOND} ${text}`);
}

export function blank(): void {
  console.log("");
}

export function divider(): void {
  console.log(chalk.dim(`  ${GLYPH.divider.repeat(ruleWidth())}`));
}

// -- Summary bar (Mole-style) ------------------------------------------------

/**
 * Summary footer with double-line separator and key-value pairs.
 *
 *   ══════════════════════════════════════════════════════
 *   380 imported  |  32 skipped  |  12 enriched
 *   ══════════════════════════════════════════════════════
 */
export function summaryBar(parts: string[]): void {
  const line = chalk.dim(`  ${SEPARATOR.repeat(ruleWidth())}`);
  console.log(line);
  console.log(`  ${parts.join(chalk.dim("  |  "))}`);
  console.log(line);
}

// -- Spinner ------------------------------------------------------------------

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
    succeed(label: string, detail?: string) {
      spinner.stop();
      stepComplete(label, detail);
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
