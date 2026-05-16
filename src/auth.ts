/**
 * CLI auth -- manages credentials for both REST v1 (preferred) and
 * legacy Supabase service-role (deprecated, removed 14 June 2026).
 *
 * Reads from:
 *   1. Environment variables (TAP_API_KEY, TAP_URL, TAP_WORKSPACE_ID,
 *      then SUPABASE_URL / SUPABASE_KEY for the legacy path)
 *   2. Config file (~/.tap/config.json)
 *
 * The auth-mode resolution:
 *   - `apiKey` set        => REST mode (preferred). Every command should
 *     route through `lib/rest.ts → restRequest()`.
 *   - `supabaseUrl + key` => legacy direct-Supabase mode. Still works for
 *     commands that haven't migrated yet; a one-time stderr deprecation
 *     banner prints on every `getClient()` call.
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

const REST_DEPRECATION_DATE = "14 June 2026";

export interface TapConfig {
  // REST v1 (preferred)
  apiKey?: string;
  tapUrl?: string;

  // Legacy Supabase (deprecated, removed 14 June 2026)
  supabaseUrl?: string;
  supabaseKey?: string;

  // Shared
  workspaceId?: string;
  anthropicKey?: string;
  perplexityKey?: string;
}

let _cachedConfig: TapConfig | null | undefined;
let _deprecationWarned = false;

export function loadConfig(): TapConfig | null {
  if (_cachedConfig !== undefined) return _cachedConfig;

  // Build a config by merging env vars over the file (env wins).
  let fromFile: TapConfig | null = null;
  if (existsSync(CONFIG_FILE)) {
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as TapConfig;
    } catch {
      fromFile = null;
    }
  }

  const envApiKey = process.env.TAP_API_KEY;
  const envUrl = process.env.SUPABASE_URL || process.env.TAP_SUPABASE_URL;
  const envKey =
    process.env.SUPABASE_KEY ||
    process.env.TAP_SUPABASE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  const envTapUrl = process.env.TAP_URL;
  const envWorkspace = process.env.TAP_WORKSPACE_ID;
  const envAnthropic = process.env.ANTHROPIC_API_KEY;

  const hasEnvAuth = envApiKey || (envUrl && envKey);

  if (!fromFile && !hasEnvAuth) {
    _cachedConfig = null;
    return null;
  }

  _cachedConfig = {
    apiKey: envApiKey ?? fromFile?.apiKey,
    tapUrl: envTapUrl ?? fromFile?.tapUrl,
    supabaseUrl: envUrl ?? fromFile?.supabaseUrl,
    supabaseKey: envKey ?? fromFile?.supabaseKey,
    workspaceId: envWorkspace ?? fromFile?.workspaceId,
    anthropicKey: envAnthropic ?? fromFile?.anthropicKey,
    perplexityKey: fromFile?.perplexityKey,
  };
  return _cachedConfig;
}

export function saveConfig(config: TapConfig): void {
  _cachedConfig = undefined; // Invalidate cache on save
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
}

/**
 * Returns true when a REST `tap_ak_*` key is configured. Commands that
 * have a REST path should prefer it; legacy commands fall through to
 * `getClient()`.
 */
export function hasApiKey(): boolean {
  const config = loadConfig();
  return Boolean(config?.apiKey);
}

/**
 * Print a one-time stderr deprecation banner the first time a command
 * falls back to the legacy direct-Supabase client.
 */
function warnLegacyAuth(): void {
  if (_deprecationWarned) return;
  _deprecationWarned = true;
  process.stderr.write(
    [
      "",
      "⚠️  tap-cli direct-Supabase mode is deprecated.",
      `    Migrate to REST v1 before ${REST_DEPRECATION_DATE}:`,
      "    1. Mint a key at https://totalaudiopromo.com/settings/api-keys",
      "    2. Run `tap auth login --api-key`",
      "    3. Existing supabaseUrl/Key entries stay in your config as a",
      "       fallback during the migration window.",
      "",
    ].join("\n"),
  );
}

export function getClient(): SupabaseClient {
  const config = loadConfig();
  if (!config || !config.supabaseUrl || !config.supabaseKey) {
    throw new Error(
      'No legacy Supabase credentials configured. Run `tap auth login --api-key` for REST mode, ' +
        "or set SUPABASE_URL + SUPABASE_KEY for legacy mode.",
    );
  }

  warnLegacyAuth();

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
