/**
 * REST v1 client. Every CLI read and write goes through
 * `https://totalaudiopromo.com/api/v1/*` with a workspace-scoped `tap_ak_*`
 * key. Mirrors `packages/tap-mcp/src/auth.ts → restRequest()` so the CLI
 * and MCP behave the same.
 */

import { loadConfig } from "../auth.js";

export interface RestRequestInit {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Abort the request after this long. A long-poll sets it above the time the server holds the read. */
  timeoutMs?: number;
  /** Abort the request when this fires, as well as on the timeout. */
  signal?: AbortSignal;
}

export class TapApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The parsed JSON body, for routes whose refusal carries detail (a 422's per-pitch reasons). */
    public readonly body: unknown = null,
    /** The Retry-After header in seconds, when a 429 or 503 carries one. */
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "TapApiError";
  }
}

const DEFAULT_BASE_URL = "https://totalaudiopromo.com";

export function getTapUrl(): string {
  return process.env.TAP_URL || loadConfig()?.tapUrl || DEFAULT_BASE_URL;
}

export function getApiKey(): string | null {
  return loadConfig()?.apiKey ?? null;
}

/** Every v1 list route caps `limit` at 200. */
export const MAX_PAGE_SIZE = 200;

/**
 * Read every page of a v1 list route. List routes answer
 * `{ [key]: T[], total }` and clamp `limit` to 200, so one page can hide rows.
 */
export async function fetchAllPages<T>(
  path: string,
  key: string,
  query: RestRequestInit["query"] = {},
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const res = await restRequest<Record<string, unknown>>(path, {
      query: { ...query, limit: MAX_PAGE_SIZE, page },
    });
    const batch = (res[key] as T[] | undefined) ?? [];
    rows.push(...batch);
    const total = typeof res.total === "number" ? res.total : rows.length;
    if (batch.length < MAX_PAGE_SIZE || rows.length >= total) return rows;
  }
}

function apiUrl(path: string, query: RestRequestInit["query"]): URL {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, getTapUrl());
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url;
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

  const url = apiUrl(path, init.query);
  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "@totalaudiopromo/tap-cli",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: requestSignal(init),
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
    throw new TapApiError(res.status, errorMessage(json) || text || res.statusText, json, retryAfter(res.headers.get("retry-after")));
  }

  return (json as T) ?? ({} as T);
}

function requestSignal(init: RestRequestInit): AbortSignal | undefined {
  const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined].filter((s) => s !== undefined);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

/** Retry-After is either seconds or an HTTP date. */
function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, (at - Date.now()) / 1000);
}

/**
 * TAP returns `{ error: "..." }` from most routes and
 * `{ success: false, error: { code, message } }` from plan and availability
 * guards (402, 503).
 */
function errorMessage(json: unknown): string | null {
  if (!json || typeof json !== "object" || !("error" in json)) return null;
  const error = (json as { error: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return null;
}

export type ApiKeyCheckResult =
  | { ok: true; scoped: boolean }
  | { ok: false; reason: "invalid-key" | "plan" | "network" | "unknown"; message: string };

/**
 * Cheap, read-only call used to verify a pasted key actually
 * authenticates before it's written to disk. Hits the campaigns list
 * with limit=1 — the lightest read endpoint that requires a valid key.
 *
 * A 401 means the key itself is bad. A 403 means the key is valid but
 * lacks `campaigns:read` — still worth saving, so that's reported as
 * `ok: true, scoped: false`. A 402 means the workspace is not on the year
 * plan; TAP's own message says so.
 */
export async function verifyApiKey(
  apiKey: string,
  baseUrl?: string,
): Promise<ApiKeyCheckResult> {
  const url = new URL("/api/v1/campaigns", baseUrl || DEFAULT_BASE_URL);
  url.searchParams.set("limit", "1");

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "@totalaudiopromo/tap-cli",
      },
    });
    if (res.status === 401) {
      return { ok: false, reason: "invalid-key", message: "Invalid or missing API key" };
    }
    if (res.status === 403) {
      return { ok: true, scoped: false };
    }
    if (res.status === 402) {
      const message = errorMessage(await res.json().catch(() => null));
      return { ok: false, reason: "plan", message: message ?? "This API key needs the TAP year plan." };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "unknown",
        message: `TAP returned ${res.status} ${res.statusText}`,
      };
    }
    return { ok: true, scoped: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "network", message };
  }
}
