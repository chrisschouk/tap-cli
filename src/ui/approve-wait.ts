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
import { onInterrupt } from "./interrupt.js";
import {
  cancelApprovalRequest,
  isFinal,
  waitForAnswer,
  type ApprovalRequest,
  type CreatedRequest,
} from "../lib/approval-requests.js";

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
  /** Read `o` and `c` from a TTY. Otherwise only Ctrl+C (SIGINT) withdraws. */
  keys: boolean;
  /** Draw the countdown. Off for --json, where stdout is the answer. */
  countdown: boolean;
  onOpen: () => void;
}

function waitingText(created: CreatedRequest, keys: boolean, note: string | null): string {
  const hint = chalk.dim(keys ? `  ${GLYPH.dot}  o open  ${GLYPH.dot}  c cancel` : `  ${GLYPH.dot}  Ctrl+C withdraws the request`);
  const status = note ?? `Waiting for an answer in TAP  ${chalk.dim(GLYPH.dot)}  ${timeLeft(created.expires_at)} left`;
  return `${status}${hint}`;
}

/**
 * Wait for the person's answer, or for a withdrawal the server accepts. A
 * withdrawal refused because someone is answering keeps waiting for them.
 */
export function awaitAnswer(created: CreatedRequest, opts: WaitOptions): Promise<ApprovalRequest> {
  const { stdin } = process;
  let note: string | null = null;
  let cancelling = false;
  let done = false;
  const spinner = ora({ text: waitingText(created, opts.keys, note), prefixText: " ", spinner: "dots", isEnabled: opts.countdown && process.stdout.isTTY });
  if (opts.countdown) spinner.start();
  const tick = setInterval(() => (spinner.text = waitingText(created, opts.keys, note)), 1000);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      done = true;
      clearInterval(tick);
      spinner.stop();
      release();
      if (!opts.keys) return;
      stdin.off("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const finish = (request: ApprovalRequest) => {
      if (done) return;
      cleanup();
      resolve(request);
    };
    const fail = (err: unknown) => {
      if (done) return;
      cleanup();
      reject(err);
    };
    function cancel() {
      if (cancelling) {
        process.stdout.write("\x1b[?25h");
        process.exit(130);
      }
      cancelling = true;
      note = "Withdrawing the request";
      spinner.text = waitingText(created, opts.keys, note);
      cancelApprovalRequest(created.id).then((request) => {
        if (isFinal(request)) return finish(request);
        cancelling = false;
        note = "Someone is answering now. Waiting for their answer";
      }, fail);
    }
    const ACTIONS: Record<string, () => void> = { o: opts.onOpen, c: cancel };
    function onKey(_: string, key: { name?: string; ctrl?: boolean }) {
      if (key?.ctrl && key.name === "c") return cancel();
      ACTIONS[key?.name ?? ""]?.();
    }

    const release = onInterrupt(cancel);
    if (opts.keys) {
      emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("keypress", onKey);
    }
    waitForAnswer(created.id, () => done).then(finish, fail);
  });
}
