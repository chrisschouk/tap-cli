/**
 * Pure helpers for generating and merging MCP client configs.
 *
 * Kept free of filesystem/process side effects so the merge logic is
 * unit-testable; `commands/mcp.ts` does the actual reading/writing.
 */

import { platform } from "node:os";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type McpConfigFile = {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
};

export const TAP_MCP_SERVER_NAME = "tap";
export const TAP_MCP_PACKAGE = "@totalaudiopromo/tap-mcp";
export const TAP_MCP_REMOTE_URL = "https://totalaudiopromo.com/api/mcp";

/**
 * Local (stdio, npx) server entry for Claude Desktop / Cursor style
 * configs that key servers under `mcpServers`.
 */
export function buildTapServerEntry(apiKey: string): McpServerEntry {
  return {
    command: "npx",
    args: ["-y", TAP_MCP_PACKAGE],
    env: { TAP_API_KEY: apiKey },
  };
}

/**
 * Merge the `tap` server into an existing MCP config object without
 * touching any other registered server. Returns a new object; does not
 * mutate the input.
 */
export function mergeMcpServerConfig(
  existing: McpConfigFile,
  serverName: string,
  entry: McpServerEntry,
): McpConfigFile {
  return {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      [serverName]: entry,
    },
  };
}

/**
 * OS-correct path to the Claude Desktop config file. Linux uses the
 * XDG config dir convention; macOS/Windows use their respective
 * Application Support dirs.
 */
export function claudeDesktopConfigPath(): string {
  const home = homedir();
  const os = platform();
  if (os === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (os === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** Cursor's global MCP config — same shape as Claude Desktop's. */
export function cursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

/** Claude Code stdio registration command (shown or run, key included). */
export function claudeCodeLocalCommand(apiKey: string): string {
  return `claude mcp add ${TAP_MCP_SERVER_NAME} -e TAP_API_KEY=${apiKey} -- npx -y ${TAP_MCP_PACKAGE}`;
}

/** Claude Code remote (OAuth) registration command — no key needed. */
export function claudeCodeRemoteCommand(): string {
  return `claude mcp add --transport http ${TAP_MCP_SERVER_NAME} ${TAP_MCP_REMOTE_URL}`;
}

/** Reads a JSON config file, returning `{}` if it doesn't exist or doesn't parse. */
export function readConfigFile(path: string): McpConfigFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as McpConfigFile;
  } catch {
    return {};
  }
}

export interface WriteResult {
  wrote: string;
  backedUpTo?: string;
}

/**
 * Writes `data` to `path`, creating parent directories as needed. If a
 * file already exists there, it's copied to `<path>.bak-<timestamp>`
 * first so a bad merge is always recoverable.
 */
export function writeConfigWithBackup(path: string, data: McpConfigFile): WriteResult {
  mkdirSync(dirname(path), { recursive: true });
  let backedUpTo: string | undefined;
  if (existsSync(path)) {
    backedUpTo = `${path}.bak-${Date.now()}`;
    copyFileSync(path, backedUpTo);
  }
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return { wrote: path, backedUpTo };
}
