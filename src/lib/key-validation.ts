/**
 * Shared validation + masking for `tap_ak_*` API keys.
 *
 * Used by `tap auth login` (format check before the network round trip)
 * and `tap doctor` / `tap mcp setup` (masking before anything touches
 * stdout).
 */

const KEY_PREFIX = "tap_ak_";
const MIN_KEY_LENGTH = 40;

export interface KeyFormatResult {
  valid: boolean;
  reason?: string;
}

/**
 * Checks the key's shape only (prefix + length) — no network call.
 */
export function checkApiKeyFormat(key: string | undefined | null): KeyFormatResult {
  if (!key) return { valid: false, reason: "Key is required" };
  if (!key.startsWith(KEY_PREFIX)) {
    return { valid: false, reason: `Must start with ${KEY_PREFIX}` };
  }
  if (key.length < MIN_KEY_LENGTH) {
    return { valid: false, reason: "Looks too short for a TAP API key" };
  }
  return { valid: true };
}

/**
 * Masks a key for display: keeps the prefix and last 4 characters,
 * replaces the middle with dots. Never print a full key to stdout
 * outside a written MCP config file.
 */
export function maskApiKey(key: string | undefined | null): string {
  if (!key) return "";
  if (key.length <= KEY_PREFIX.length + 4) return `${KEY_PREFIX}...`;
  const tail = key.slice(-4);
  return `${KEY_PREFIX}${"•".repeat(6)}${tail}`;
}
