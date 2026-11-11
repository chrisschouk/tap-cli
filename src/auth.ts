/**
 * CLI credentials. The CLI talks to TAP only through the REST v1 API with a
 * workspace-scoped `tap_ak_*` key (see `lib/rest.ts`).
 *
 * Reads from environment variables (TAP_API_KEY, TAP_URL),
 * then the config file (~/.tap/config.json). Environment wins.
 */

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
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/** Keys left by the removed direct-Supabase mode. The CLI never reads them. */
const LEGACY_SUPABASE_KEYS = ["supabaseUrl", "supabaseKey"] as const;

export interface TapConfig {
  apiKey?: string;
  tapUrl?: string;
  /** Where `apiKey` came from: TAP_API_KEY wins over the config file. */
  apiKeySource?: "env" | "file";
}

type ConfigFile = Record<string, unknown>;

let _cachedConfig: TapConfig | null | undefined;
let warnedLegacy = false;

function readConfigFile(): ConfigFile | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as ConfigFile;
  } catch {
    return null;
  }
}

function warnLegacySupabase(file: ConfigFile): void {
  if (warnedLegacy || !LEGACY_SUPABASE_KEYS.some((k) => k in file)) return;
  warnedLegacy = true;
  process.stderr.write(
    `  ! ${CONFIG_FILE} still holds supabaseUrl/supabaseKey. The CLI no longer uses them.\n` +
      "    Delete those two keys (or run `tap auth login`, which drops them) and rotate the\n" +
      "    Supabase service-role key, since it has sat on disk in plain text.\n",
  );
}

function stringField(file: ConfigFile | null, key: string): string | undefined {
  const value = file?.[key];
  return typeof value === "string" ? value : undefined;
}

export function loadConfig(): TapConfig | null {
  if (_cachedConfig !== undefined) return _cachedConfig;

  const file = readConfigFile();
  if (file) warnLegacySupabase(file);
  const envApiKey = process.env.TAP_API_KEY;
  const fileApiKey = stringField(file, "apiKey");

  if (!file && !envApiKey) {
    _cachedConfig = null;
    return null;
  }

  _cachedConfig = {
    apiKey: envApiKey ?? fileApiKey,
    tapUrl: process.env.TAP_URL ?? stringField(file, "tapUrl"),
    apiKeySource: envApiKey ? "env" : fileApiKey ? "file" : undefined,
  };
  return _cachedConfig;
}

/** The API key saved in the config file, whatever TAP_API_KEY says. */
export function fileApiKey(): string | undefined {
  return stringField(readConfigFile(), "apiKey");
}

/**
 * Write the API key and base URL, keeping every other key in the file
 * (openrouterKey and the like) and dropping the legacy Supabase fields.
 */
export function saveConfig(update: { apiKey: string; tapUrl?: string }): void {
  _cachedConfig = undefined;
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const next: ConfigFile = { ...(readConfigFile() ?? {}), ...update };
  for (const key of LEGACY_SUPABASE_KEYS) delete next[key];
  if (update.tapUrl === undefined) delete next.tapUrl;
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
}
