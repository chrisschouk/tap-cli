/**
 * `tap mcp setup` (alias `tap connect`) — wires the stored `tap_ak_*`
 * key into an MCP client config.
 *
 * Default behaviour is print-only. Nothing is written to disk unless
 * the caller passes `--write` or confirms an interactive prompt — and
 * even then, an existing config file is backed up first and only the
 * `tap` server entry is touched.
 */

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import * as clack from "@clack/prompts";
import { getApiKey } from "../lib/rest.js";
import { maskApiKey } from "../lib/key-validation.js";
import {
  buildTapServerEntry,
  claudeCodeLocalCommand,
  claudeCodeRemoteCommand,
  claudeDesktopConfigPath,
  cursorConfigPath,
  mergeMcpServerConfig,
  readConfigFile,
  writeConfigWithBackup,
  TAP_MCP_SERVER_NAME,
} from "../lib/mcp-config.js";
import * as out from "../output.js";

type Target = "claude-code" | "claude-desktop" | "cursor";

function isClaudeOnPath(): boolean {
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

function printClaudeCode(apiKey: string): void {
  out.info("Claude Code (local, stdio):");
  console.log(`  ${claudeCodeLocalCommand(maskApiKey(apiKey))}`);
  out.info("Claude Code (remote, OAuth — no key stored locally):");
  console.log(`  ${claudeCodeRemoteCommand()}`);
}

async function runClaudeCode(apiKey: string, write: boolean): Promise<void> {
  printClaudeCode(apiKey);
  if (!write) return;
  if (!isClaudeOnPath()) {
    out.warn("`claude` was not found on PATH — run the command above manually.");
    return;
  }
  const confirmed = await clack.confirm({
    message: "Run `claude mcp add tap ...` now?",
    initialValue: false,
  });
  if (clack.isCancel(confirmed) || !confirmed) return;
  const result = spawnSync(
    "claude",
    ["mcp", "add", TAP_MCP_SERVER_NAME, "-e", `TAP_API_KEY=${apiKey}`, "--", "npx", "-y", "@totalaudiopromo/tap-mcp"],
    { stdio: "inherit" },
  );
  if (result.status === 0) {
    out.success("Registered tap with Claude Code.");
  } else {
    out.error("`claude mcp add` failed — see output above.");
  }
}

async function writeDesktopStyleConfig(
  path: string,
  apiKey: string,
  write: boolean,
  label: string,
): Promise<void> {
  const entry = buildTapServerEntry(apiKey);
  const maskedEntry = buildTapServerEntry(maskApiKey(apiKey));
  const existing = readConfigFile(path);
  const merged = mergeMcpServerConfig(existing, TAP_MCP_SERVER_NAME, maskedEntry);

  out.info(`${label} config: ${path}`);
  console.log(JSON.stringify(merged, null, 2));

  if (!write) return;
  const confirmed = await clack.confirm({
    message: `Write this into ${path}? (existing file is backed up first)`,
    initialValue: false,
  });
  if (clack.isCancel(confirmed) || !confirmed) return;

  const finalConfig = mergeMcpServerConfig(existing, TAP_MCP_SERVER_NAME, entry);
  const result = writeConfigWithBackup(path, finalConfig);
  out.success(`Wrote ${result.wrote}`);
  if (result.backedUpTo) out.info(`Backup: ${result.backedUpTo}`);
}

interface SetupOpts {
  target?: Target;
  write?: boolean;
}

async function runMcpSetup(opts: SetupOpts): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    out.error("No TAP API key configured. Run `tap auth login` first.");
    process.exit(1);
  }

  const write = Boolean(opts.write);
  const targets = opts.target ? [opts.target] : (["claude-code", "claude-desktop", "cursor"] as Target[]);

  for (const target of targets) {
    if (target === "claude-code") {
      await runClaudeCode(apiKey, write);
    } else if (target === "claude-desktop") {
      await writeDesktopStyleConfig(claudeDesktopConfigPath(), apiKey, write, "Claude Desktop");
    } else if (target === "cursor") {
      await writeDesktopStyleConfig(cursorConfigPath(), apiKey, write, "Cursor");
    } else {
      out.error(`Unknown target: ${target}. Use claude-code, claude-desktop, or cursor.`);
    }
    console.log("");
  }

  if (!write) {
    out.info("Printed only — pass --write to merge these into the actual config files.");
  }
}

function addSetupOptions(cmd: Command): Command {
  return cmd
    .option(
      "-t, --target <target>",
      "claude-code | claude-desktop | cursor (default: print all)",
    )
    .option("--write", "Write/merge config files instead of only printing");
}

export function mcpCommand(): Command {
  const cmd = new Command("mcp").description("Wire the stored API key into an MCP client");

  addSetupOptions(
    cmd
      .command("setup")
      .description("Print (or write) MCP config for Claude Code, Claude Desktop, or Cursor"),
  ).action(async (opts: SetupOpts) => runMcpSetup(opts));

  return cmd;
}

/** `tap connect` — shorthand alias for `tap mcp setup`. */
export function connectCommand(): Command {
  const cmd = new Command("connect").description(
    "Alias for `tap mcp setup` — wire the stored API key into an MCP client",
  );
  return addSetupOptions(cmd).action(async (opts: SetupOpts) => runMcpSetup(opts));
}
