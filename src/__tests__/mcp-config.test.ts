import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTapServerEntry,
  mergeMcpServerConfig,
  readConfigFile,
  writeConfigWithBackup,
  TAP_MCP_SERVER_NAME,
} from "../lib/mcp-config.js";

// ---------------------------------------------------------------------------
// buildTapServerEntry
// ---------------------------------------------------------------------------

describe("buildTapServerEntry", () => {
  it("builds an npx stdio entry carrying the key as an env var", () => {
    const entry = buildTapServerEntry("tap_ak_live_abc123");
    expect(entry.command).toBe("npx");
    expect(entry.args).toContain("@totalaudiopromo/tap-mcp");
    expect(entry.env?.TAP_API_KEY).toBe("tap_ak_live_abc123");
  });
});

// ---------------------------------------------------------------------------
// mergeMcpServerConfig
// ---------------------------------------------------------------------------

describe("mergeMcpServerConfig", () => {
  it("adds the tap server to an empty config", () => {
    const entry = buildTapServerEntry("key");
    const merged = mergeMcpServerConfig({}, TAP_MCP_SERVER_NAME, entry);
    expect(merged.mcpServers?.tap).toEqual(entry);
  });

  it("preserves existing servers untouched", () => {
    const existing = {
      mcpServers: {
        other: { command: "node", args: ["other-server.js"] },
      },
    };
    const entry = buildTapServerEntry("key");
    const merged = mergeMcpServerConfig(existing, TAP_MCP_SERVER_NAME, entry);
    expect(merged.mcpServers?.other).toEqual(existing.mcpServers.other);
    expect(merged.mcpServers?.tap).toEqual(entry);
  });

  it("overwrites only its own entry when tap already exists", () => {
    const existing = {
      mcpServers: {
        tap: { command: "old", args: ["stale"] },
        other: { command: "node", args: ["x.js"] },
      },
    };
    const entry = buildTapServerEntry("new-key");
    const merged = mergeMcpServerConfig(existing, TAP_MCP_SERVER_NAME, entry);
    expect(merged.mcpServers?.tap).toEqual(entry);
    expect(merged.mcpServers?.other).toEqual(existing.mcpServers.other);
  });

  it("does not mutate the input object", () => {
    const existing = { mcpServers: { other: { command: "node", args: [] } } };
    const snapshot = JSON.stringify(existing);
    mergeMcpServerConfig(existing, TAP_MCP_SERVER_NAME, buildTapServerEntry("key"));
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// readConfigFile / writeConfigWithBackup
// ---------------------------------------------------------------------------

describe("readConfigFile + writeConfigWithBackup", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads {} for a missing file", () => {
    dir = mkdtempSync(join(tmpdir(), "tap-cli-test-"));
    expect(readConfigFile(join(dir, "nope.json"))).toEqual({});
  });

  it("reads {} for an unparseable file rather than throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "tap-cli-test-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    expect(readConfigFile(path)).toEqual({});
  });

  it("writes a new config file, creating parent directories", () => {
    dir = mkdtempSync(join(tmpdir(), "tap-cli-test-"));
    const path = join(dir, "nested", "config.json");
    const result = writeConfigWithBackup(path, { mcpServers: { tap: buildTapServerEntry("k") } });
    expect(existsSync(path)).toBe(true);
    expect(result.backedUpTo).toBeUndefined();
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.mcpServers.tap.env.TAP_API_KEY).toBe("k");
  });

  it("backs up an existing file before overwriting it", () => {
    dir = mkdtempSync(join(tmpdir(), "tap-cli-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }));

    const result = writeConfigWithBackup(path, {
      mcpServers: { other: { command: "x", args: [] }, tap: buildTapServerEntry("k") },
    });

    expect(result.backedUpTo).toBeDefined();
    expect(existsSync(result.backedUpTo as string)).toBe(true);
    const backup = JSON.parse(readFileSync(result.backedUpTo as string, "utf-8"));
    expect(backup.mcpServers.other).toEqual({ command: "x", args: [] });

    const current = JSON.parse(readFileSync(path, "utf-8"));
    expect(current.mcpServers.tap.env.TAP_API_KEY).toBe("k");
    expect(current.mcpServers.other).toEqual({ command: "x", args: [] });
  });
});
