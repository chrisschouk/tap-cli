/**
 * TUI formatting: logo, step indicators, dividers, pipeline, summary.
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

// -- Logo ---------------------------------------------------------------------

const LOGO_LINES = [
  "   __",
  "  / /____ ____",
  " / __/ _ `/ _ \\",
  " \\__/\\_,_/ .__/",
  "        /_/",
];

const COMMANDS = [
  ["campaigns", "list, create, view details"],
  ["contacts", "search, add, view details"],
  ["pitch", "generate AI pitch drafts"],
  ["send", "send a pitch via Gmail"],
  ["outcome", "log a campaign outcome"],
  ["queue", "today's action queue"],
  ["discover", "find new contacts"],
  ["import", "import contacts from CSV"],
  ["stats", "workspace statistics"],
  ["watch", "live campaign updates"],
];

const BOX_WIDTH = 56;
const H = "\u2500"; // ─
const TL = "\u250C"; // ┌
const TR = "\u2510"; // ┐
const BL = "\u2514"; // └
const BR = "\u2518"; // ┘
const V = "\u2502"; // │

const border = chalk.hex(COLOUR.primary).dim;

function boxLine(content: string, rawLen: number): string {
  const pad = BOX_WIDTH - 3 - rawLen; // -3 = two borders + leading space
  return `  ${border(V)} ${content}${" ".repeat(Math.max(0, pad))}${border(V)}`;
}

function emptyBoxLine(): string {
  return `  ${border(V)}${" ".repeat(BOX_WIDTH - 2)}${border(V)}`;
}

export function intro(version: string, opts?: { commands?: boolean; contextBar?: { contacts: number; campaigns: number; followUps: number } }): void {
  const top = `  ${border(TL + H.repeat(BOX_WIDTH - 2) + TR)}`;
  const bottom = `  ${border(BL + H.repeat(BOX_WIDTH - 2) + BR)}`;
  const logo = chalk.hex(COLOUR.primary).bold;
  const versionStr = `v${version}`;
  const tagline = "Total Audio Platform CLI";

  console.log("");
  console.log(top);
  console.log(emptyBoxLine());

  // Logo lines with version/tagline on lines 3-4
  for (let i = 0; i < LOGO_LINES.length; i++) {
    const art = logo(LOGO_LINES[i]);
    const artLen = LOGO_LINES[i].length;

    if (i === 2) {
      // Version right of logo
      const gap = 4;
      const content = `${art}${" ".repeat(gap)}${chalk.dim(versionStr)}`;
      console.log(boxLine(content, artLen + gap + versionStr.length));
    } else if (i === 3) {
      // Tagline right of logo
      const gap = 4;
      const content = `${art}${" ".repeat(gap)}${chalk.dim(tagline)}`;
      console.log(boxLine(content, artLen + gap + tagline.length));
    } else {
      console.log(boxLine(art, artLen));
    }
  }

  if (opts?.commands) {
    console.log(emptyBoxLine());

    // Commands header
    const cmdHeader = chalk.hex(COLOUR.primary)("Commands:");
    console.log(boxLine(`  ${cmdHeader}`, 2 + "Commands:".length));

    for (const [name, desc] of COMMANDS) {
      const label = chalk.hex(COLOUR.primary)(name.padEnd(14));
      const description = chalk.dim(desc);
      const rawLen = 2 + 14 + desc.length;
      console.log(boxLine(`  ${label}${description}`, rawLen));
    }

    console.log(emptyBoxLine());

    // Navigation hint
    const nav = "Arrows to navigate, Enter to select, Ctrl+C";
    console.log(boxLine(`  ${chalk.dim(nav)}`, 2 + nav.length));
  }

  // Context bar (live workspace stats inside the box)
  if (opts?.contextBar) {
    const cb = opts.contextBar;
    const parts = [
      `${chalk.hex(COLOUR.primary)(String(cb.contacts))} contacts`,
      `${chalk.hex(COLOUR.primary)(String(cb.campaigns))} campaigns`,
      cb.followUps > 0
        ? `${chalk.hex(COLOUR.warning)(String(cb.followUps))} follow-ups`
        : chalk.dim("queue clear"),
    ];
    const barContent = parts.join(chalk.dim("  " + GLYPH.dot + "  "));
    const barRawLen = `${cb.contacts} contacts  .  ${cb.campaigns} campaigns  .  ${cb.followUps > 0 ? `${cb.followUps} follow-ups` : "queue clear"}`.length;
    console.log(boxLine(`  ${barContent}`, 2 + barRawLen));
  }

  console.log(emptyBoxLine());
  console.log(bottom);
  console.log("");
}

/**
 * Compact header for command output (no tagline).
 */
export function commandHeader(title: string, meta?: string): void {
  console.log("");
  if (meta) {
    console.log(
      `  ${chalk.bold(title)}${" ".repeat(Math.max(1, 52 - title.length - meta.length))}${chalk.dim(meta)}`,
    );
  } else {
    console.log(`  ${chalk.bold(title)}`);
  }
  console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));
}

// -- Steps & checkpoints ------------------------------------------------------

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
  console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));
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

// -- Summary bar (Mole-style) ------------------------------------------------

/**
 * Summary footer with double-line separator and key-value pairs.
 *
 *   ══════════════════════════════════════════════════════
 *   380 imported  |  32 skipped  |  12 enriched
 *   ══════════════════════════════════════════════════════
 */
export function summaryBar(parts: string[]): void {
  const line = chalk.dim(`  ${SEPARATOR.repeat(52)}`);
  console.log(line);
  console.log(`  ${parts.join(chalk.dim("  |  "))}`);
  console.log(line);
}

/**
 * Summary card with label-value rows inside separator bars.
 */
export function summaryCard(rows: Array<[string, string]>): void {
  const line = chalk.dim(`  ${SEPARATOR.repeat(52)}`);
  console.log(line);
  for (const [label, value] of rows) {
    console.log(`  ${chalk.dim(label.padEnd(20))}${value}`);
  }
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
