/**
 * The ask and the wait: the code, the link and a QR of it, then a countdown
 * until a person answers in TAP. `o` opens the link here; `c` or Ctrl+C
 * withdraws the request.
 */

import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";
import ora from "ora";
import { renderUnicodeCompact } from "uqr";
import { COLOUR, GLYPH } from "./theme.js";
import { stripAnsi } from "./detail.js";
import { exitInterrupted, type InterruptHold } from "./interrupt.js";
import {
  isFinal,
  waitForAnswer,
  withdrawApprovalRequest,
  type ApprovalRequest,
  type CreatedRequest,
} from "../lib/approval-requests.js";
import type { RetryHooks } from "../lib/retry.js";

const accent = chalk.hex(COLOUR.primary);
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

function infoLines(created: CreatedRequest): string[] {
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
function askLayout(created: CreatedRequest, width: number, withQr: boolean): string[] {
  const info = infoLines(created);
  if (!withQr) return info.map((l) => `  ${l}`);
  const qr = qrLines(created.url);
  const qrWidth = stripAnsi(qr[0]).length;
  if (width < qrWidth + 4) return info.map((l) => `  ${l}`);
  if (width < qrWidth + QR_GAP + INFO_WIDTH + 2) return [...info.map((l) => `  ${l}`), "", ...qr.map((l) => `  ${l}`)];
  const top = Math.max(0, Math.floor((qr.length - info.length) / 2));
  return qr.map((line, i) => `  ${line}${" ".repeat(QR_GAP)}${info[i - top] ?? ""}`.trimEnd());
}

export function printAsk(created: CreatedRequest, opts: { qr: boolean }): void {
  const width = process.stdout.columns || 100;
  console.log("");
  for (const line of askLayout(created, width, opts.qr)) console.log(line);
  console.log("");
  console.log(`  ${accent(created.url)}`);
  console.log("");
}

interface WaitOptions {
  /** Read `o` and `c` from a TTY. Otherwise only a signal withdraws. */
  keys: boolean;
  /** Draw the countdown. Off for --json, where stdout is the answer. */
  countdown: boolean;
  onOpen: () => void;
  /** Taken before the request was created, so an earlier interrupt withdraws at once. */
  hold: InterruptHold;
}

function waitingText(created: CreatedRequest, keys: boolean, note: string | null): string {
  const hint = chalk.dim(keys ? `  ${GLYPH.dot}  o open  ${GLYPH.dot}  c cancel` : `  ${GLYPH.dot}  Ctrl+C withdraws the request`);
  const status = note ?? `Waiting for an answer in TAP  ${chalk.dim(GLYPH.dot)}  ${timeLeft(created.expires_at)} left`;
  return `${status}${hint}`;
}

/** Retry notes as stderr lines, for reads made before the countdown starts. */
export function retryLog(created: Pick<CreatedRequest, "expires_at">): RetryHooks {
  return {
    onRetry: (reason, delayMs) => console.error(`  ${retryNote(reason, delayMs, created)}`),
    onRecover: () => console.error("  Back in touch with TAP."),
  };
}

function retryNote(reason: string, delayMs: number, created: Pick<CreatedRequest, "expires_at">): string {
  return `${reason}. Trying again in ${Math.ceil(delayMs / 1000)}s, until ${clockTime(created.expires_at)}`;
}

/** The countdown line. Without a spinner on screen, retry notes go to stderr as lines. */
function waitingLine(created: CreatedRequest, opts: WaitOptions) {
  let note: string | null = null;
  const spinner = ora({ text: waitingText(created, opts.keys, note), prefixText: " ", spinner: "dots", isEnabled: opts.countdown && process.stdout.isTTY });
  if (opts.countdown) spinner.start();
  const render = () => (spinner.text = waitingText(created, opts.keys, note));
  const tick = setInterval(render, 1000);
  const log = (text: string) => (spinner.isSpinning ? undefined : console.error(`  ${text}`));
  return {
    note(text: string | null) {
      note = text;
      render();
    },
    hooks: {
      onRetry: (reason: string, delayMs: number) => {
        note = retryNote(reason, delayMs, created);
        render();
        log(note);
      },
      onRecover: () => {
        note = null;
        render();
        log("Back in touch with TAP.");
      },
    },
    stop() {
      clearInterval(tick);
      spinner.stop();
    },
  };
}

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
 * Wait for the person's answer, or for a withdrawal the server accepts. A
 * withdrawal refused because someone is answering keeps waiting for them.
 * A second interrupt while withdrawing exits at once.
 */
export function awaitAnswer(created: CreatedRequest, opts: WaitOptions): Promise<ApprovalRequest> {
  const line = waitingLine(created, opts);
  let cancelling = false;
  let done = false;

  return new Promise((resolve, reject) => {
    const settle = <T>(fn: (value: T) => void) => (value: T) => {
      if (done) return;
      done = true;
      line.stop();
      stopKeys();
      fn(value);
    };
    const finish = settle(resolve);
    const fail = settle(reject);
    const cancel = () => {
      if (cancelling) exitInterrupted();
      cancelling = true;
      line.note("Withdrawing the request");
      withdrawApprovalRequest(created, line.hooks).then((request) => {
        if (isFinal(request)) return finish(request);
        cancelling = false;
        line.note("Someone is answering now. Waiting for their answer");
      }, fail);
    };
    const stopKeys = opts.keys ? listenForKeys({ o: opts.onOpen, c: opts.hold.trigger }, opts.hold.trigger) : () => {};
    opts.hold.handle(cancel);
    waitForAnswer(created, { ...line.hooks, stopped: () => done }).then(finish, fail);
  });
}
