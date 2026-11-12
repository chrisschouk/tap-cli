import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every TAP route the CLI may call. Adding a call means adding it here, where
 * review sees it. Approving and sending a pitch are human-only in TAP, so no
 * approve or send route may ever appear. POST /campaigns/:id/pitches drafts
 * pitches; it does not send them. The approval-request routes ask a person,
 * read their answer and withdraw the ask; only a signed-in browser session can
 * answer (apps/tap/app/api/approval-requests/:id/answer, outside v1).
 * POST /pitches/:id/propose queues a draft for review and approves nothing.
 */
const ALLOWED = new Set([
  "GET /api/v1/actions",
  "POST /api/v1/approval-requests",
  "GET /api/v1/approval-requests/:id",
  "POST /api/v1/approval-requests/:id/cancel",
  "GET /api/v1/campaigns",
  "POST /api/v1/campaigns",
  "GET /api/v1/campaigns/:id",
  "PATCH /api/v1/campaigns/:id",
  "GET /api/v1/campaigns/:id/contacts",
  "POST /api/v1/campaigns/:id/contacts",
  "GET /api/v1/campaigns/:id/pitches",
  "POST /api/v1/campaigns/:id/pitches",
  "GET /api/v1/contacts",
  "POST /api/v1/contacts",
  "GET /api/v1/contacts/:id",
  "POST /api/v1/contacts/enrich",
  "GET /api/v1/invocations/:id",
  "GET /api/v1/outcomes",
  "POST /api/v1/outcomes",
  "GET /api/v1/outreach/queue",
  "POST /api/v1/pitches/:id/propose",
  "GET /api/v1/skills",
  "GET /api/v1/skills/:id",
  "POST /api/v1/skills/:id/fork",
  "POST /api/v1/skills/:id/run",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const files = sourceFiles(join(process.cwd(), "src")).map((path) => ({ path, text: readFileSync(path, "utf-8") }));

const API_LITERAL = /["'`](\/api\/[^"'`]*)["'`]/g;

function normalise(path: string): string {
  return path.replace(/\$\{[^}]*\}/g, ":id");
}

/** Index of the parenthesis that closes the call opening at `open`. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return i;
  }
  return text.length;
}

/** Each restRequest/fetchAllPages/new URL call: its method and the route its first /api/ literal names. */
function calls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\b(restRequest|fetchAllPages|new URL)\b/g)) {
    const pathAt = text.slice(match.index).search(API_LITERAL);
    if (pathAt < 0) continue;
    const start = match.index + pathAt;
    const open = text.lastIndexOf("(", start);
    const call = text.slice(open, closingParen(text, open) + 1);
    const path = normalise(new RegExp(API_LITERAL.source).exec(call)?.[1] ?? "");
    if (!path) continue;
    const method = /method:\s*["'](GET|POST|PATCH|PUT|DELETE)["']/.exec(call)?.[1] ?? "GET";
    found.push(`${method} ${path}`);
  }
  return found;
}

const used = files.flatMap((f) => calls(f.text).map((route) => ({ route, path: f.path })));

describe("the CLI reaches TAP only through REST v1", () => {
  it("never imports a Supabase client", () => {
    const offenders = files.filter((f) => f.text.includes("@supabase/")).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("calls only allowlisted routes", () => {
    const offenders = used.filter((u) => !ALLOWED.has(u.route));
    expect(offenders).toEqual([]);
  });

  it("has no /api/ path outside a call the guardrail can read", () => {
    const literals = files.flatMap((f) => [...f.text.matchAll(API_LITERAL)].map((m) => normalise(m[1])));
    const readable = new Set(used.map((u) => u.route.split(" ")[1]));
    expect(literals.filter((p) => !readable.has(p))).toEqual([]);
  });

  it("finds the calls it guards", () => {
    expect(new Set(used.map((u) => u.route)).size).toBeGreaterThan(15);
  });

  it("allows no approve or send route; approving and sending are human-only in TAP", () => {
    const askOnly = /^(POST|GET) \/api\/v1\/approval-requests(\/:id(\/cancel)?)?$/;
    expect([...ALLOWED].filter((r) => /approv|\/send|\/answer/.test(r) && !askOnly.test(r))).toEqual([]);
  });
});
