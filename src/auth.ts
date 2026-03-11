/**
 * CLI auth -- manages Supabase credentials and API keys.
 *
 * Reads from:
 *   1. Environment variables (SUPABASE_URL, SUPABASE_KEY)
 *   2. Config file (~/.tap/config.json)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".tap");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface TapConfig {
  supabaseUrl: string;
  supabaseKey: string;
  workspaceId?: string;
  anthropicKey?: string;
}

export function loadConfig(): TapConfig | null {
  // Check env vars first
  const envUrl = process.env.SUPABASE_URL || process.env.TAP_SUPABASE_URL;
  const envKey =
    process.env.SUPABASE_KEY ||
    process.env.TAP_SUPABASE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (envUrl && envKey) {
    return {
      supabaseUrl: envUrl,
      supabaseKey: envKey,
      workspaceId: process.env.TAP_WORKSPACE_ID,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
    };
  }

  // Fall back to config file
  if (!existsSync(CONFIG_FILE)) return null;

  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as TapConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: TapConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
}

export function getClient(): SupabaseClient {
  const config = loadConfig();
  if (!config) {
    throw new Error(
      'Not authenticated. Run "tap auth login" or set SUPABASE_URL and SUPABASE_KEY environment variables.',
    );
  }

  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getWorkspaceId(): string | undefined {
  const config = loadConfig();
  return config?.workspaceId || process.env.TAP_WORKSPACE_ID;
}

export function getAnthropicKey(): string | undefined {
  // Env var takes priority
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const config = loadConfig();
  return config?.anthropicKey;
}

export async function resolveWorkspaceId(
  supabase: SupabaseClient,
  provided?: string,
): Promise<string> {
  if (provided) return provided;

  const fromConfig = getWorkspaceId();
  if (fromConfig) return fromConfig;

  // Try to find the first workspace
  const { data } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .limit(1)
    .single();

  if (data?.workspace_id) return data.workspace_id;

  throw new Error(
    "Could not resolve workspace. Pass --workspace or set TAP_WORKSPACE_ID.",
  );
}
