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
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface TapConfig {
  apiKey?: string;
  tapUrl?: string;
}

let _cachedConfig: TapConfig | null | undefined;

function readConfigFile(): TapConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as TapConfig;
    return { apiKey: raw.apiKey, tapUrl: raw.tapUrl };
  } catch {
    return null;
  }
}

export function loadConfig(): TapConfig | null {
  if (_cachedConfig !== undefined) return _cachedConfig;

  const fromFile = readConfigFile();
  const envApiKey = process.env.TAP_API_KEY;

  if (!fromFile && !envApiKey) {
    _cachedConfig = null;
    return null;
  }

  _cachedConfig = {
    apiKey: envApiKey ?? fromFile?.apiKey,
    tapUrl: process.env.TAP_URL ?? fromFile?.tapUrl,
  };
  return _cachedConfig;
}

export function saveConfig(config: TapConfig): void {
  _cachedConfig = undefined;
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const { apiKey, tapUrl } = config;
  writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey, tapUrl }, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
}
