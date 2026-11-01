/**
 * `tap doctor` — a green/red checklist of everything a smooth first run
 * depends on: Node version, a stored key, TAP reachability, and whether
 * the companion MCP package resolves.
 */

import { Command } from "commander";
import { getApiKey, getTapUrl, verifyApiKey } from "../lib/rest.js";
import { checkApiKeyFormat } from "../lib/key-validation.js";
import { TAP_MCP_PACKAGE } from "../lib/mcp-config.js";
import * as out from "../output.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const MIN_NODE_MAJOR = 20;

function checkNodeVersion(): CheckResult {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    name: "Node.js version",
    ok,
    detail: ok
      ? `v${process.versions.node}`
      : `v${process.versions.node} — tap-cli requires Node ${MIN_NODE_MAJOR}+`,
  };
}

function checkStoredKey(): CheckResult {
  const key = getApiKey();
  if (!key) {
    return {
      name: "Stored API key",
      ok: false,
      detail: 'None found — run "tap auth login".',
    };
  }
  const format = checkApiKeyFormat(key);
  return {
    name: "Stored API key",
    ok: format.valid,
    detail: format.valid ? "Present, well-formed" : `Present but invalid — ${format.reason}`,
  };
}

async function checkApiReachable(): Promise<CheckResult> {
  const key = getApiKey();
  if (!key) {
    return {
      name: "TAP API reachable",
      ok: false,
      detail: "Skipped — no key to verify with.",
    };
  }
  const result = await verifyApiKey(key, getTapUrl());
  if (result.ok) {
    return {
      name: "TAP API reachable",
      ok: true,
      detail: result.scoped ? "Reachable, key authenticates" : "Reachable, key valid but lacks campaigns:read",
    };
  }
  return { name: "TAP API reachable", ok: false, detail: result.message };
}

async function checkMcpPackageResolvable(): Promise<CheckResult> {
  const url = `https://registry.npmjs.org/${TAP_MCP_PACKAGE}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return {
      name: "MCP package resolvable",
      ok: res.ok,
      detail: res.ok
        ? `${TAP_MCP_PACKAGE} found on npm`
        : `npm registry returned ${res.status} for ${TAP_MCP_PACKAGE}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: "MCP package resolvable", ok: false, detail: `Could not reach npm: ${message}` };
  }
}

export async function runDoctorChecks(): Promise<CheckResult[]> {
  return [checkNodeVersion(), checkStoredKey(), await checkApiReachable(), await checkMcpPackageResolvable()];
}

function printChecks(results: CheckResult[]): void {
  for (const result of results) {
    if (result.ok) out.success(`${result.name}: ${result.detail}`);
    else out.error(`${result.name}: ${result.detail}`);
  }
}

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Check Node version, stored key, API reachability, and MCP package resolution")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const results = await runDoctorChecks();
      if (opts.json) {
        out.json({ ok: results.every((r) => r.ok), checks: results });
        return;
      }
      printChecks(results);
      const allOk = results.every((r) => r.ok);
      console.log("");
      if (allOk) out.success("Everything looks good.");
      else out.warn("Some checks failed — see red lines above.");
      if (!allOk) process.exitCode = 1;
    });
}
