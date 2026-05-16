/**
 * REST v1 client — proxies every read and write through
 * `https://totalaudiopromo.com/api/v1/*` with a workspace-scoped
 * `tap_ak_*` key.
 *
 * Mirrors `packages/tap-mcp/src/auth.ts → restRequest()` so the two
 * clients behave the same. Per Plan §Pillar 1, this is the way CLI and
 * MCP both consume TAP — Supabase service-role credentials stay
 * available for a 30-day deprecation window only.
 */

import { loadConfig } from "../auth.js";

export interface RestRequestInit {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export class TapApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TapApiError";
  }
}

const DEFAULT_BASE_URL = "https://totalaudiopromo.com";

/**
 * Resolve the REST base URL. Order:
 *   1. TAP_URL env var
 *   2. config.tapUrl
 *   3. https://totalaudiopromo.com
 */
export function getTapUrl(): string {
  if (process.env.TAP_URL) return process.env.TAP_URL;
  const config = loadConfig();
  return config?.tapUrl || DEFAULT_BASE_URL;
}

/**
 * Resolve the API key. Order:
 *   1. TAP_API_KEY env var
 *   2. config.apiKey
 */
export function getApiKey(): string | null {
  if (process.env.TAP_API_KEY) return process.env.TAP_API_KEY;
  const config = loadConfig();
  return config?.apiKey ?? null;
}

export function hasApiKey(): boolean {
  return Boolean(getApiKey());
}

export async function restRequest<T = unknown>(
  path: string,
  init: RestRequestInit = {},
): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'No TAP API key configured. Run `tap auth login --api-key` or set TAP_API_KEY=tap_ak_... in your environment.',
    );
  }
  if (!apiKey.startsWith("tap_ak_")) {
    throw new Error("TAP_API_KEY must start with tap_ak_");
  }

  const base = getTapUrl();
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "@totalaudiopromo/tap-cli",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON response; surface verbatim
    }
  }

  if (!res.ok) {
    const errorMessage =
      json && typeof json === "object" && "error" in (json as Record<string, unknown>)
        ? String((json as Record<string, unknown>).error)
        : text || res.statusText;
    throw new TapApiError(res.status, errorMessage);
  }

  return (json as T) ?? ({} as T);
}
