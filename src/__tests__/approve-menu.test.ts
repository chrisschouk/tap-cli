import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startFakeTap, CAMPAIGN_ID } from "./fake-tap.js";
import { runTapPty } from "./tap-process.js";

let tapServer: Awaited<ReturnType<typeof startFakeTap>>;
let mark = 0;

beforeAll(async () => {
  tapServer = await startFakeTap();
  process.env.TAP_URL = tapServer.url;
  process.env.TAP_API_KEY = "tap_ak_test";
  process.env.NO_COLOR = "1";
});
beforeEach(() => {
  tapServer.reset();
  mark = tapServer.requests.length;
});
afterAll(() => tapServer.close());

const CANCEL_PATH = /^\/api\/v1\/approval-requests\/[^/]+\/cancel$/;
const since = () => tapServer.requests.slice(mark);
const longPolling = () => since().some((r) => r.method === "GET" && r.query.wait === "25");
const cancelArrived = () => since().some((r) => r.method === "POST" && CANCEL_PATH.test(r.path));
const onlyApproval = () => [...tapServer.state.approvals.values()][0];

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`never happened: ${what}`);
}

/** Pretend stdin and stdout are a terminal, recording every raw mode change. */
function fakeTerminal() {
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw: boolean };
  const saved = { stdinTTY: stdin.isTTY, stdoutTTY: process.stdout.isTTY, setRawMode: stdin.setRawMode };
  const modes: boolean[] = [];
  Object.assign(stdin, { isTTY: true, isRaw: false });
  Object.assign(process.stdout, { isTTY: true });
  stdin.setRawMode = ((raw: boolean) => {
    modes.push(raw);
    stdin.isRaw = raw;
    return stdin;
  }) as typeof stdin.setRawMode;
  return {
    modes,
    press: (name: string, ctrl = false) => stdin.emit("keypress", ctrl ? undefined : name, { name, ctrl }),
    restore() {
      Object.assign(stdin, { isTTY: saved.stdinTTY, setRawMode: saved.setRawMode });
      Object.assign(process.stdout, { isTTY: saved.stdoutTTY });
    },
  };
}

describe("tap approve inside the interactive menu", () => {
  it("returns to the menu with raw mode off and no key listener left, after c twice during a slow withdrawal", async () => {
    tapServer.state.faults.push({ method: "POST", path: CANCEL_PATH, fault: { delayMs: 2000 } });
    const realExit = process.exit;
    const printed: string[] = [];
    const capture = (...args: unknown[]) => void printed.push(args.join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const terminal = fakeTerminal();
    const keyListeners = process.stdin.listenerCount("keypress");
    try {
      const { runCommand } = await import("../ui/run-command.js");
      const run = runCommand(["approve", CAMPAIGN_ID, "--all"]);
      await until(longPolling, "the CLI is waiting for the answer");
      terminal.press("c");
      await until(cancelArrived, "the CLI asked to withdraw");
      terminal.press("c");
      await expect(run).resolves.toBeUndefined();
    } finally {
      terminal.restore();
      vi.restoreAllMocks();
    }
    const { id } = onlyApproval();
    expect(process.exit).toBe(realExit);
    expect(terminal.modes.at(0)).toBe(true);
    expect(terminal.modes.at(-1)).toBe(false);
    expect(process.stdin.listenerCount("keypress")).toBe(keyListeners);
    expect(printed.join("\n")).toContain("You quit before TAP confirmed an answer or a withdrawal.");
    expect(printed.join("\n")).toContain(`tap approve status ${id} --wait`);
    await until(() => onlyApproval().status === "cancelled", "the slow withdrawal landed");
  }, 30_000);

  it("drives menu, Approve, c twice with a slow withdrawal, and comes back to the menu", async () => {
    tapServer.state.faults.push({ method: "POST", path: CANCEL_PATH, fault: { delayMs: 3000 } });
    const run = await runTapPty(tapServer, [], [
      { wait: "What would you like to do?" },
      { send: "\x1B[B\x1B[B\x1B[B" },
      { wait: "ask a person to approve pitches in TAP" },
      { send: "\r" },
      { wait: "Which campaign?" },
      { send: "\r" },
      { wait: "Choose the pitches to ask about" },
      { send: "\r" },
      { wait: "c cancel" },
      { send: "c" },
      { wait: "Withdrawing the request" },
      { send: "c" },
      { wait: "tap approve status" },
      { wait: "What would you like to do?" },
      { send: "\x03" },
      { wait: "Cheers." },
    ]);
    const { id } = onlyApproval();
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("You quit before TAP confirmed an answer or a withdrawal.");
    expect(run.stdout).toContain(`tap approve status ${id} --wait`);
    expect(run.stdout).not.toMatch(/CommandExit|exit 130|Error:/);
    await until(() => onlyApproval().status === "cancelled", "the slow withdrawal landed");
  }, 40_000);
});
