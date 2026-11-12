/**
 * Run the CLI as a child process against a fake TAP, the way a person or an
 * agent runs it: no colour, a fresh HOME, the key and URL in the environment.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Recorded, startFakeTap } from "./fake-tap.js";

type FakeTap = Awaited<ReturnType<typeof startFakeTap>>;

/** One node process with tsx loaded in it, so signals reach the CLI itself (the tsx wrapper relays only SIGINT and SIGTERM). */
const CLI = ["--import", "tsx", "src/cli.ts"];

export function freshHome(config?: object): string {
  const home = mkdtempSync(join(tmpdir(), "tap-cli-"));
  if (config) {
    mkdirSync(join(home, ".tap"));
    writeFileSync(join(home, ".tap", "config.json"), JSON.stringify(config));
  }
  return home;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** Leave stdin open for `onSpawn` to close, instead of closing it at once. */
  stdinOpen?: boolean;
  onSpawn?: (child: ChildProcess) => void;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
  calls: Recorded[];
}

export function runTap(server: FakeTap, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const before = server.requests.length;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...CLI, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: freshHome(),
        NO_COLOR: "1",
        TAP_API_KEY: "tap_ak_test",
        TAP_URL: server.url,
        ...opts.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (!opts.stdinOpen) child.stdin.end(opts.stdin ?? "");
    opts.onSpawn?.(child);
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr, output: stdout + stderr, calls: server.requests.slice(before) }),
    );
  });
}

export type PtyStep = { wait: string } | { send: string };

/** Run the CLI in a pseudo-terminal of `rows` by `cols`, typing keys as each awaited text appears. */
export function runTapPty(server: FakeTap, args: string[], steps: PtyStep[], size = { rows: 24, cols: 100 }): Promise<RunResult> {
  const before = server.requests.length;
  const cli = [process.execPath, ...CLI, ...args];
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", join(process.cwd(), "src/__tests__/pty-driver.py"), String(size.rows), String(size.cols), "--", ...cli], {
      env: { PATH: process.env.PATH, HOME: freshHome(), NO_COLOR: "1", TERM: "xterm-256color", TAP_API_KEY: "tap_ak_test", TAP_URL: server.url },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(JSON.stringify(steps));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr, output: stdout + stderr, calls: server.requests.slice(before) }));
  });
}
