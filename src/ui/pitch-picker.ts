/**
 * Choose which waiting pitches to ask about. A reducer over key presses keeps
 * the rules testable; the loop below only draws and reads keys.
 */

import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";
import { COLOUR, GLYPH } from "./theme.js";
import { truncate } from "../output.js";

export interface PickerPitch {
  id: string;
  subject: string;
  body: string | null;
}

export interface PickerState {
  cursor: number;
  chosen: ReadonlySet<string>;
  reading: boolean;
  done: "ask" | "quit" | null;
}

export type PickerKey = "up" | "down" | "toggle" | "all" | "read" | "ask" | "quit";

export function initialPicker(pitches: PickerPitch[]): PickerState {
  return { cursor: 0, chosen: new Set(pitches.map((p) => p.id)), reading: false, done: null };
}

function toggled(chosen: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(chosen);
  if (!next.delete(id)) next.add(id);
  return next;
}

const STEP: Record<PickerKey, (s: PickerState, pitches: PickerPitch[]) => PickerState> = {
  up: (s, p) => ({ ...s, cursor: (s.cursor - 1 + p.length) % p.length }),
  down: (s, p) => ({ ...s, cursor: (s.cursor + 1) % p.length }),
  toggle: (s, p) => ({ ...s, chosen: toggled(s.chosen, p[s.cursor].id) }),
  all: (s, p) => ({ ...s, chosen: s.chosen.size === p.length ? new Set() : new Set(p.map((x) => x.id)) }),
  read: (s) => ({ ...s, reading: !s.reading }),
  ask: (s) => (s.chosen.size > 0 ? { ...s, done: "ask" } : s),
  quit: (s) => ({ ...s, done: "quit" }),
};

export function stepPicker(state: PickerState, key: PickerKey, pitches: PickerPitch[]): PickerState {
  return STEP[key](state, pitches);
}

const KEY_BY_NAME: Record<string, PickerKey> = {
  up: "up",
  k: "up",
  down: "down",
  j: "down",
  space: "toggle",
  a: "all",
  r: "read",
  right: "read",
  return: "ask",
  enter: "ask",
  q: "quit",
  escape: "quit",
};

function keyFor(key: { name?: string; ctrl?: boolean }): PickerKey | null {
  if (key.ctrl && key.name === "c") return "quit";
  return KEY_BY_NAME[key.name ?? ""] ?? null;
}

function oneLine(body: string | null): string {
  return (body ?? "").replace(/\s+/g, " ").trim();
}

/** Word-wrap to `width`, keeping the body's own line breaks. */
function wrap(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => {
    const out: string[] = [];
    let current = "";
    for (const word of line.split(" ")) {
      if (current && current.length + word.length + 1 > width) {
        out.push(current);
        current = word;
      } else current = current ? `${current} ${word}` : word;
    }
    return [...out, current];
  });
}

const BODY_LINES = 16;

function bodyLines(pitch: PickerPitch, width: number): string[] {
  const lines = wrap(pitch.body?.trim() || "This pitch has no body yet.", width - 6);
  const shown = lines.slice(0, BODY_LINES).map((l) => `    ${l}`);
  if (lines.length > BODY_LINES) shown.push(chalk.dim(`    ${lines.length - BODY_LINES} more lines. Read the rest in TAP.`));
  return ["", chalk.dim(`  ${GLYPH.divider.repeat(Math.min(52, width - 4))}`), `  ${chalk.bold(truncate(pitch.subject, width - 4))}`, "", ...shown];
}

function pitchRow(pitch: PickerPitch, focused: boolean, chosen: boolean, width: number): string[] {
  const mark = chosen ? chalk.hex(COLOUR.primary)(GLYPH.diamondFilled) : chalk.dim(GLYPH.diamond);
  const pointer = focused ? chalk.hex(COLOUR.primary)("›") : " ";
  const subject = truncate(pitch.subject, width - 8);
  const preview = truncate(oneLine(pitch.body), width - 8);
  return [`  ${pointer} ${mark} ${focused ? chalk.bold(subject) : subject}`, preview ? `      ${chalk.dim(preview)}` : ""].filter(Boolean);
}

export function renderPicker(state: PickerState, pitches: PickerPitch[], width: number): string[] {
  const title = "Choose the pitches to ask about";
  const count = `${state.chosen.size} of ${pitches.length} chosen`;
  const gap = Math.max(2, Math.min(52, width - 4) - title.length - count.length);
  const lines = ["", `  ${chalk.bold(title)}${" ".repeat(gap)}${chalk.dim(count)}`, chalk.dim(`  ${GLYPH.divider.repeat(Math.min(52, width - 4))}`)];
  pitches.forEach((p, i) => lines.push(...pitchRow(p, i === state.cursor, state.chosen.has(p.id), width)));
  if (state.reading) lines.push(...bodyLines(pitches[state.cursor], width));
  const keys = ["↑↓ move", "space choose", "a all", "r read", "enter ask", "q quit"];
  const hint = keys.join(`  ${GLYPH.dot}  `);
  lines.push("", chalk.dim(`  ${hint.length + 3 < width ? hint : keys.join(" ")}`));
  return lines;
}

/** Interactive pick on a TTY. Resolves with the chosen ids, or null when the person quits. */
export function pickPitches(pitches: PickerPitch[]): Promise<string[] | null> {
  const { stdin, stdout } = process;
  let state = initialPicker(pitches);
  let drawn = 0;
  const draw = () => {
    const width = stdout.columns || 100;
    const lines = renderPicker(state, pitches, width);
    if (drawn > 0) stdout.write(`\x1b[${drawn}A\x1b[0J`);
    stdout.write(lines.join("\n") + "\n");
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write("\x1b[?25l");
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      const action = keyFor(key ?? {});
      if (!action) return;
      state = stepPicker(state, action, pitches);
      if (!state.done) return draw();
      stdout.write(`\x1b[${drawn}A\x1b[0J`);
      stdin.off("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\x1b[?25h");
      resolve(state.done === "ask" ? pitches.filter((p) => state.chosen.has(p.id)).map((p) => p.id) : null);
    };
    stdin.on("keypress", onKey);
    draw();
  });
}
