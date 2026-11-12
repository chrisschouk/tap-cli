/**
 * Choose which waiting pitches to ask about. A reducer over key presses keeps
 * the rules testable; the loop below only draws and reads keys.
 */

import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";
import { COLOUR, GLYPH } from "./theme.js";
import { truncate } from "../output.js";
import type { PendingPitch, Recipient } from "../lib/pending-pitches.js";

export type PickerPitch = Pick<PendingPitch, "id" | "subject" | "body" | "recipient">;

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

export interface PickerView {
  width: number;
  /** Terminal rows. The picker draws at most one fewer, so redrawing in place never scrolls. */
  height: number;
}

/** `Jo Presenter <jo@bbc.co.uk>, BBC Radio 6 Music`, or null when the pitches route did not say. */
export function recipientText(r: Recipient | null): string | null {
  if (!r) return null;
  const who = r.name && r.to ? `${r.name} <${r.to}>` : (r.name ?? r.to);
  return [who, r.outlet].filter(Boolean).join(", ") || null;
}

const RECIPIENTS_LATER = "TAP lists who each pitch goes to once you ask. If one is wrong, press c to withdraw the request.";
const NOT_SHOWN = "Not shown here: the release block TAP adds below the body, and the sender. The approve page shows the whole email.";

function rule(width: number): string {
  return chalk.dim(`  ${GLYPH.divider.repeat(Math.min(52, width - 4))}`);
}

function header(state: PickerState, pitches: PickerPitch[], width: number): string[] {
  const title = "Choose the pitches to ask about";
  const count = `${state.chosen.size} of ${pitches.length} chosen`;
  const gap = Math.max(2, Math.min(52, width - 4) - title.length - count.length);
  return ["", `  ${chalk.bold(title)}${" ".repeat(gap)}${chalk.dim(count)}`, rule(width)];
}

function notes(text: string, width: number): string[] {
  return wrap(text, width - 6).map((l) => chalk.dim(`  ${l}`));
}

function footer(reading: boolean, width: number): string[] {
  const keys = reading
    ? ["↑↓ next", "space choose", "r back", "enter ask", "q quit"]
    : ["↑↓ move", "space choose", "a all", "r read", "enter ask", "q quit"];
  const hint = keys.join(`  ${GLYPH.dot}  `);
  return ["", chalk.dim(`  ${truncate(hint.length + 3 < width ? hint : keys.join(" "), width - 3)}`)];
}

function pitchRow(pitch: PickerPitch, focused: boolean, chosen: boolean, width: number): string[] {
  const mark = chosen ? chalk.hex(COLOUR.primary)(GLYPH.diamondFilled) : chalk.dim(GLYPH.diamond);
  const pointer = focused ? chalk.hex(COLOUR.primary)("›") : " ";
  const subject = truncate(pitch.subject, width - 8);
  const to = recipientText(pitch.recipient);
  const second = truncate(to ? `To ${to}` : oneLine(pitch.body), width - 8);
  return [`  ${pointer} ${mark} ${focused ? chalk.bold(subject) : subject}`, second ? `      ${chalk.dim(second)}` : ""].filter(Boolean);
}

/** The slice of the list to draw: all of it when it fits, else a window that keeps the cursor near the middle. */
export function listWindow(count: number, cursor: number, capacity: number): [number, number] {
  if (count <= capacity) return [0, count];
  const start = Math.min(Math.max(0, cursor - Math.floor(capacity / 2)), count - capacity);
  return [start, start + capacity];
}

const ROWS_PER_PITCH = 2;

function listLines(state: PickerState, pitches: PickerPitch[], width: number, budget: number): string[] {
  const fits = pitches.length * ROWS_PER_PITCH <= budget;
  const capacity = fits ? pitches.length : Math.max(1, Math.floor((budget - 2) / ROWS_PER_PITCH));
  const [start, end] = listWindow(pitches.length, state.cursor, capacity);
  const rows = pitches.slice(start, end).flatMap((p, i) => pitchRow(p, start + i === state.cursor, state.chosen.has(p.id), width));
  if (fits) return rows;
  const more = (n: number, arrow: string) => chalk.dim(n > 0 ? `      ${arrow} ${n} more` : "");
  return [more(start, "↑"), ...rows, more(pitches.length - end, "↓")];
}

function readLines(pitch: PickerPitch, width: number, budget: number): string[] {
  const to = recipientText(pitch.recipient);
  const top = [`  ${chalk.bold(truncate(pitch.subject, width - 4))}`, chalk.dim(`  ${truncate(to ? `To ${to}` : "To: shown once you ask", width - 4)}`), ""];
  const tail = ["", ...notes(NOT_SHOWN, width)];
  const room = Math.max(3, budget - top.length - tail.length - 1);
  const body = wrap(pitch.body?.trim() || "This pitch has no body yet.", width - 6);
  const shown = body.slice(0, room).map((l) => `    ${l}`);
  if (body.length > room) shown.push(chalk.dim(`    ${body.length - room} more lines. Read the rest in TAP.`));
  return [...top, ...shown, ...tail];
}

/** The read view replaces the list, so a whole pitch fits a 24-row terminal. */
export function renderPicker(state: PickerState, pitches: PickerPitch[], view: PickerView): string[] {
  const { width } = view;
  const head = header(state, pitches, width);
  const foot = footer(state.reading, width);
  const notice = !state.reading && pitches.some((p) => !p.recipient) ? notes(RECIPIENTS_LATER, width) : [];
  const budget = view.height - 1 - head.length - foot.length - notice.length;
  const middle = state.reading ? readLines(pitches[state.cursor], width, budget) : listLines(state, pitches, width, budget);
  return [...head, ...notice, ...middle, ...foot];
}

/** Interactive pick on a TTY. Resolves with the chosen ids, or null when the person quits. */
export function pickPitches(pitches: PickerPitch[]): Promise<string[] | null> {
  const { stdin, stdout } = process;
  let state = initialPicker(pitches);
  let drawn = 0;
  const draw = () => {
    const lines = renderPicker(state, pitches, { width: stdout.columns || 100, height: stdout.rows || 24 });
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
