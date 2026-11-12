/**
 * The ask and the wait: the code, the link and a QR of it, then a countdown
 * until a person answers in TAP. `o` opens the link here; `c` or Ctrl+C
 * asks to withdraw the request, and a second press quits without waiting.
 */

import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";
import ora from "ora";
import { renderUnicodeCompact } from "uqr";
import { COLOUR, GLYPH } from "./theme.js";
import { stripAnsi } from "./detail.js";
import type { CreatedRequest } from "../lib/approval-requests.js";
import type { RetryHooks } from "../lib/retry.js";
import { settle, type Ending, type SessionView, type StopRequest } from "../lib/approval-session.js";

const accent = chalk.hex(COLOUR.primary);

/** What the ask shows. */
type Ask = Pick<CreatedRequest, "code" | "url" | "expires_at">;
const QR_GAP = 4;
const INFO_WIDTH = 46;

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** `14:52` minutes and seconds until `iso`, never below zero. */
export function timeLeft(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function infoLines(created: Ask): string[] {
  return [
    `${chalk.dim("Code")}    ${accent.bold(created.code.split("").join(" "))}`,
    "",
    "Open the link on your phone or computer,",
    "signed in to TAP. Check the page shows",
    "the same code, then approve there.",
    "",
    chalk.dim(`Expires at ${clockTime(created.expires_at)}`),
  ];
}

function qrLines(url: string): string[] {
  return renderUnicodeCompact(url, { border: 1 }).split("\n");
}

/** QR and words side by side when they fit, stacked when only the QR fits, words alone below that. */
function askLayout(created: Ask, width: number, withQr: boolean): string[] {
  const info = infoLines(created);
  if (!withQr) return info.map((l) => `  ${l}`);
  const qr = qrLines(created.url);
  const qrWidth = stripAnsi(qr[0]).length;
  if (width < qrWidth + 4) return info.map((l) => `  ${l}`);
  if (width < qrWidth + QR_GAP + INFO_WIDTH + 2) return [...info.map((l) => `  ${l}`), "", ...qr.map((l) => `  ${l}`)];
  const top = Math.max(0, Math.floor((qr.length - info.length) / 2));
  return qr.map((line, i) => `  ${line}${" ".repeat(QR_GAP)}${info[i - top] ?? ""}`.trimEnd());
}

export function printAsk(created: Ask, opts: { qr: boolean }): void {
  const width = process.stdout.columns || 100;
  console.log("");
  for (const line of askLayout(created, width, opts.qr)) console.log(line);
  console.log("");
  console.log(`  ${accent(created.url)}`);
  console.log("");
}

interface WaitOptions {
  /** Read `o` and `c` from a TTY. Otherwise only a signal stops the wait. */
  keys: boolean;
  /** Draw the countdown. Off for --json, where stdout is the answer. */
  countdown: boolean;
  onOpen: () => void;
  /** Runs before the countdown starts, with the keys already live. */
  prelude?: (signal: AbortSignal, hooks: RetryHooks) => Promise<void>;
}

function waitingText(created: CreatedRequest, keys: boolean, note: string | null): string {
  const hint = chalk.dim(keys ? `  ${GLYPH.dot}  o open  ${GLYPH.dot}  c cancel` : `  ${GLYPH.dot}  Ctrl+C withdraws the request`);
  const status = note ?? `Waiting for an answer in TAP  ${chalk.dim(GLYPH.dot)}  ${timeLeft(created.expires_at)} left`;
  return `${status}${hint}`;
}

function retryNote(reason: string, delayMs: number, created: Pick<CreatedRequest, "expires_at">): string {
  return `${reason}. Trying again in ${Math.ceil(delayMs / 1000)}s, until ${clockTime(created.expires_at)}`;
}

/** The countdown line, started once the prelude is done. Without a spinner on screen, notes go to stderr as lines. */
function waitingLine(created: CreatedRequest, opts: WaitOptions) {
  let note: string | null = null;
  const spinner = ora({ text: waitingText(created, opts.keys, note), prefixText: " ", spinner: "dots", isEnabled: opts.countdown && process.stdout.isTTY });
  const render = () => (spinner.text = waitingText(created, opts.keys, note));
  const tick = setInterval(render, 1000);
  const say = (text: string | null) => {
    note = text;
    render();
    if (text && !spinner.isSpinning) console.error(`  ${text}`);
  };
  const view: SessionView = {
    note: say,
    hooks: {
      onRetry: (reason, delayMs) => say(retryNote(reason, delayMs, created)),
      onRecover: () => {
        say(null);
        if (!spinner.isSpinning) console.error("  Back in touch with TAP.");
      },
    },
  };
  return {
    view,
    start() {
      if (opts.countdown) spinner.start();
    },
    stop() {
      clearInterval(tick);
      spinner.stop();
    },
  };
}

/** Raw keys until the returned function runs. Ctrl+C arrives as a key in raw mode. */
function listenForKeys(actions: Record<string, () => void>, onCtrlC: () => void): () => void {
  const { stdin } = process;
  const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
    if (key?.ctrl && key.name === "c") return onCtrlC();
    actions[key?.name ?? ""]?.();
  };
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("keypress", onKey);
  return () => {
    stdin.off("keypress", onKey);
    stdin.setRawMode(false);
    stdin.pause();
  };
}

/**
 * Wait for the person's answer with the countdown and keys on screen. `c` and
 * Ctrl+C press `stop`; the flow decides what that means. The keys, the raw
 * mode and the countdown are released before this returns, whatever the ending.
 */
export async function waitOnScreen(created: CreatedRequest, stop: StopRequest, opts: WaitOptions): Promise<Ending> {
  const line = waitingLine(created, opts);
  const press = () => stop.press();
  const stopKeys = opts.keys ? listenForKeys({ o: opts.onOpen, c: press }, press) : () => {};
  try {
    return await settle(created, stop, {
      ...line.view,
      prelude: async (signal, hooks) => {
        await opts.prelude?.(signal, hooks);
        line.start();
      },
    });
  } finally {
    line.stop();
    stopKeys();
  }
}
