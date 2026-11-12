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
    const child = spawn(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "src/cli.ts", ...args], {
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
    child.stdin.end(opts.stdin ?? "");
    opts.onSpawn?.(child);
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr, output: stdout + stderr, calls: server.requests.slice(before) }),
    );
  });
}
