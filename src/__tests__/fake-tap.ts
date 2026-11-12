/**
 * A fake TAP REST v1 server for CLI tests and demos. Response shapes, limits
 * and query handling are copied from the route handlers in
 * total-audio-platform/apps/tap/app/api/v1 (select lists, `limit` clamped to
 * 200, `updated_at desc` ordering on the outreach queue, 500 contacts per
 * import, 200 contact ids per campaign link, results capped at 100).
 *
 * Approval requests follow apps/tap/app/api/v1/approval-requests: POST
 * refuses with 422 unless every pitch waits for approval, GET holds the
 * connection for up to `?wait` seconds (max 25) while pending and reads as
 * expired past the deadline, and cancel answers 409 with the request once a
 * person has started answering, holding that 409 for up to 25 seconds while
 * their answer finishes. Tests answer through `answerApproval`, which stands
 * in for the signed-in person on the approve page.
 *
 * `faults` and `outage` model what a long wait meets: a 429 with Retry-After
 * (the v1 rate limit, lib/api/api-key-auth.ts rateLimitHeaders), a 5xx blip,
 * a connection dropped mid-wait, a slow response, a key refused mid-wait
 * (401, 403), or TAP unreachable.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | undefined;
  body: unknown;
  /** Epoch ms the request arrived. */
  at: number;
}

/** One injected failure, used by the first request whose method and path match. */
export type Fault =
  | { status: 429; retryAfter: number }
  | { status: 500 | 502 | 503 }
  /** The v1 gate refusing the key mid-wait: revoked (401) or scope removed (403). */
  | { status: 401 | 403 }
  | { dropAfterMs: number }
  | { delayMs: number };

export interface FaultRule {
  method: string;
  path: RegExp;
  /** Match only requests carrying these query values, such as the long poll's `wait: "25"`. */
  query?: Record<string, string>;
  fault: Fault;
}

/** A fault as the fake served it, with the fake's own clock. */
export interface Served {
  rule: FaultRule;
  at: number;
}

interface Contact {
  id: string;
  name: string;
  email: string;
  outlet: string | null;
  role: string | null;
  pipeline_status: string;
  enriched: boolean;
  enriched_at: string | null;
  platform_type: string | null;
  genres: string[] | null;
  geographic_scope: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface QueueRow {
  id: string;
  subject: string;
  body: string;
  to: string | null;
  state: string;
  send_status: string;
  scheduled_for: string | null;
  updated_at: string;
}

type Reply = [number, unknown];

export type ApprovalAnswer = "decline" | "claim" | { skip?: Record<string, string> };

interface FakeApproval {
  id: string;
  code: string;
  status: string;
  items: Array<{ pitch_id: string; to: string | null; subject: string | null }>;
  result: { approved: string[]; skipped: Array<{ id: string; reason: string }> } | null;
  created_at: string;
  expires_at: string;
  answered_at: string | null;
  answered_via: string | null;
}

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CODES = ["K7QM", "H4TW", "R9PX", "B3NV", "Z6CJ"];
type Handler = (req: { query: Record<string, string>; body: unknown; params: string[] }) => Reply;

export const CAMPAIGN_ID = "0b6f7a52-1c1d-4e0a-9d3e-5a1f2c3b4d5e";
export const CAMPAIGN = {
  id: CAMPAIGN_ID,
  name: "Night Drive",
  artist_name: "sadact",
  release_title: "Night Drive",
  release_date: "2026-12-01",
  status: "active",
  services: ["radio"],
};

/** The year-plan guard runs inside authenticateApiKey, so every route answers 402. */
export const NO_PLAN_KEY = "tap_ak_noplan";
const PLAN_REFUSAL: Reply = [
  402,
  {
    success: false,
    error: {
      code: "SUBSCRIPTION_REQUIRED",
      message:
        "This API key needs the £129 year plan. Release packs cover the app; the API and MCP server are year-plan only.",
    },
  },
];

function uuid(prefix: number, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${hex}`;
}

function iso(minutesAgo: number): string {
  return new Date(Date.UTC(2026, 10, 11, 12, 0) - minutesAgo * 60_000).toISOString();
}

const NAMED = [
  { name: "Jo Presenter", email: "jo@bbc.co.uk", outlet: "BBC Radio 6 Music" },
  { name: "Maya Okafor", email: "maya@nts.live", outlet: "NTS Radio" },
  { name: "Dev Shah", email: "dev@worldwidefm.net", outlet: "Worldwide FM" },
];

const BODY = (name: string) =>
  `Hi ${name},\n\nNight Drive is the new single from sadact, out 1 December. It is a slow, late-night track built around a looped Rhodes and a drum machine.\n\nI think it would sit well on your show. Happy to send stems or a clean edit.\n\nThanks,\nChris`;

const named = (i: number) => NAMED[i] ?? { name: `Contact ${i + 1}`, email: `contact${i + 1}@example.com`, outlet: `Outlet ${i + 1}` };

function seedContacts(count: number): Contact[] {
  return Array.from({ length: count }, (_, i) => ({
    id: uuid(0xc0, i + 1),
    ...named(i),
    role: i === 0 ? "presenter" : null,
    pipeline_status: "new",
    enriched: i % 3 === 0,
    enriched_at: i % 3 === 0 ? iso(i) : null,
    platform_type: i % 2 === 0 ? "radio" : "press",
    genres: null,
    geographic_scope: null,
    notes: null,
    created_at: iso(i),
    updated_at: iso(i),
  }));
}

/**
 * The queue is ordered updated_at desc, so the 220 recently sent rows come
 * first: one page of 200 holds none of the pitches still waiting.
 */
function seedQueue(sent: number): QueueRow[] {
  const sentRows = Array.from({ length: sent }, (_, i) => ({
    id: uuid(0xa0, i + 1),
    subject: `Sent pitch ${i + 1}`,
    body: "",
    to: null,
    state: "sent",
    send_status: "sent",
    scheduled_for: null,
    updated_at: iso(i),
  }));
  const row = (n: number, subject: string, state: string, send_status: string, to: number | null, scheduled_for: string | null = null): QueueRow => ({
    id: uuid(0xb0, n),
    subject,
    body: to === null ? "" : BODY(NAMED[to].name.split(" ")[0]),
    to: to === null ? null : NAMED[to].email,
    state,
    send_status,
    scheduled_for,
    updated_at: iso(sent + n),
  });
  const waiting: QueueRow[] = [
    row(1, "Night Drive for your Friday show", "pending_approval", "draft", 0),
    row(2, "Approved already", "approved", "draft", null, "2026-11-12T09:00:00Z"),
    row(3, "Gmail refused this one", "approved", "failed", null),
    row(4, "Waiting on the release pack", "approved", "held_for_payment", null),
    row(5, "Still a draft", "draft", "draft", 1),
    row(6, "Night Drive, a late one for NTS", "pending_approval", "draft", 1),
    row(7, "New sadact single for Worldwide FM", "pending_approval", "draft", 2),
  ];
  return [...sentRows, ...waiting];
}

function pageOf<T>(rows: T[], query: Record<string, string>) {
  const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit ?? "50", 10) || 50));
  const offset = (page - 1) * limit;
  return { rows: rows.slice(offset, offset + limit), page, limit };
}

function matches(c: Contact, search: string): boolean {
  const needle = search.toLowerCase();
  return [c.name, c.email, c.outlet].some((v) => v?.toLowerCase().includes(needle));
}

export interface FakeTapOptions {
  contacts?: number;
  sentPitches?: number;
  /** Extra pitches waiting for approval, after the three named ones. */
  extraWaiting?: number;
  /** Give GET /campaigns/:id/pitches the recipient fields the TAP change will add. */
  pitchRecipients?: boolean;
}

function extraWaitingRows(count: number, after: number): QueueRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: uuid(0xb1, i + 1),
    subject: `Pitch ${String(i + 1).padStart(2, "0")} for ${named(i + 3).outlet}`,
    body: BODY(named(i + 3).name),
    to: named(i + 3).email,
    state: "pending_approval",
    send_status: "draft",
    scheduled_for: null,
    updated_at: iso(after + i),
  }));
}

export function fakeTapState(opts: FakeTapOptions = {}, appUrl = "https://totalaudiopromo.com") {
  const contacts = seedContacts(opts.contacts ?? 230);
  const queue = seedQueue(opts.sentPitches ?? 220);
  queue.push(...extraWaitingRows(opts.extraWaiting ?? 0, queue.length));
  const campaignContacts = [
    { contact: contacts[0], pitch_status: "not_started" },
    { contact: contacts[1], pitch_status: "not_pitched" },
    { contact: contacts[2], pitch_status: "sent" },
  ];

  const listContacts: Handler = ({ query }) => {
    let rows = contacts;
    if (query.search) rows = rows.filter((c) => matches(c, query.search));
    if (query.platform_type) rows = rows.filter((c) => c.platform_type === query.platform_type);
    const { rows: pageRows, page, limit } = pageOf(rows, query);
    const select = pageRows.map(({ id, name, email, outlet, role, pipeline_status, enriched, enriched_at, platform_type, created_at, updated_at }) => ({
      id, name, email, outlet, role, pipeline_status, enriched, enriched_at, platform_type, created_at, updated_at,
    }));
    return [200, { contacts: select, total: rows.length, page, limit }];
  };

  const field = (raw: Record<string, unknown>, key: string) => (raw[key] as string | undefined) ?? null;

  function importOne(raw: Record<string, unknown>): { email: string; status: string; reason?: string } {
    const email = typeof raw.email === "string" ? raw.email.toLowerCase().trim() : "";
    if (!email) return { email: "", status: "invalid", reason: "missing_email" };
    if (contacts.some((c) => c.email === email)) return { email, status: "skipped", reason: "duplicate" };
    contacts.unshift({
      id: uuid(0xd0, contacts.length + 1),
      name: field(raw, "name") ?? email,
      email,
      outlet: field(raw, "outlet"),
      role: field(raw, "role"),
      pipeline_status: "new",
      enriched: false,
      enriched_at: null,
      platform_type: field(raw, "platform_type"),
      genres: (raw.genres as string[] | undefined) ?? null,
      geographic_scope: field(raw, "geographic_scope"),
      notes: field(raw, "notes"),
      created_at: iso(-1),
      updated_at: iso(-1),
    });
    return { email, status: "imported" };
  }

  const importContacts: Handler = ({ body }) => {
    const input = (body as { contacts?: Array<Record<string, unknown>> }).contacts ?? [];
    if (input.length === 0) return [400, { error: "contacts array is required and must not be empty" }];
    if (input.length > 500) return [400, { error: "Maximum 500 contacts per request" }];
    const results = input.map(importOne);
    const count = (status: string) => results.filter((r) => r.status === status).length;
    return [200, { imported: count("imported"), skipped: count("skipped"), invalid: count("invalid"), duplicatesInRequest: 0, results: results.slice(0, 100) }];
  };

  const linkContacts: Handler = ({ body }) => {
    const ids = (body as { contact_ids?: string[] }).contact_ids ?? [];
    if (ids.length === 0) return [400, { error: "contact_ids array is required and must not be empty" }];
    if (ids.length > 200) return [400, { error: "Maximum 200 contacts per request" }];
    const known = ids.filter((id) => contacts.some((c) => c.id === id));
    return [201, { added: known.length, already_linked: 0, failed: [], outlet_already_on_release: [], invalid_ids: ids.filter((id) => !known.includes(id)) }];
  };

  const outreachQueue: Handler = ({ query }) => {
    let rows = query.source === "sequence_execution" ? [] : queue;
    if (query.state) rows = rows.filter((r) => r.state === query.state);
    const { rows: pageRows, page, limit } = pageOf(rows, query);
    const items = pageRows.map((r) => ({
      id: r.id,
      source: "pitch_draft",
      campaign_id: CAMPAIGN_ID,
      campaign_contact_id: null,
      channel: "email",
      state: r.state,
      send_status: r.send_status,
      dispatch_attempts: 0,
      scheduled_for: r.scheduled_for,
      executed_at: null,
      gmail_message_id: null,
      gmail_thread_id: null,
      created_at: r.updated_at,
      updated_at: r.updated_at,
    }));
    return [200, { items, total: rows.length, page, limit }];
  };

  const recipientFields = (r: QueueRow) => {
    if (!opts.pitchRecipients) return {};
    const contact = contacts.find((c) => c.email === r.to);
    return { to: r.to, contact_name: contact?.name ?? null, outlet: contact?.outlet ?? null };
  };

  const campaignPitches: Handler = () => [
    200,
    {
      pitches: queue.map((r) => ({
        ...recipientFields(r),
        id: r.id,
        title: null,
        subject: r.subject,
        body: r.body,
        source: "api",
        voice_profile_id: null,
        send_status: r.send_status,
        last_used_at: null,
        successful_outcomes_count: 0,
        created_at: r.updated_at,
        updated_at: r.updated_at,
      })),
      total: queue.length,
    },
  ];

  const approvals = new Map<string, FakeApproval>();
  const approvalCtl = { ttlMs: 15 * 60_000 };

  const publicRequest = (a: FakeApproval) => {
    const final = a.status !== "pending";
    return {
      id: a.id,
      code: a.code,
      status: a.status,
      url: `${appUrl}/approve/${a.id}`,
      origin: "cli",
      item_count: a.items.length,
      items: a.items,
      result: a.result,
      created_at: a.created_at,
      expires_at: a.expires_at,
      answered_at: final ? a.answered_at : null,
      answered_via: final ? a.answered_via : null,
    };
  };

  /** store.ts expireIfDue: past the deadline an unclaimed request expires. */
  const expireIfDue = (a: FakeApproval) => {
    if (a.status === "pending" && !a.answered_at && Date.parse(a.expires_at) <= Date.now()) a.status = "expired";
    return a;
  };

  /** The route's zod body: 1 to 50 distinct uuids and a known origin. */
  const parseAsk = (body: unknown): string[] | null => {
    const { pitch_ids: ids, origin } = (body ?? {}) as { pitch_ids?: string[]; origin?: string };
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) return null;
    if (new Set(ids).size !== ids.length || !ids.every((id) => UUID.test(id))) return null;
    return ["cli", "mcp", "agent_session"].includes(origin ?? "") ? ids : null;
  };

  const rejectionOf = (id: string) => {
    const row = queue.find((r) => r.id === id);
    if (!row) return "not_found";
    return row.state === "pending_approval" ? null : "not_pending";
  };

  /** store.ts supersedeOverlapping: an unclaimed pending request that shares a pitch is replaced. */
  const supersede = (ids: string[]) => {
    for (const other of approvals.values()) {
      if (other.status === "pending" && !other.answered_at && other.items.some((i) => ids.includes(i.pitch_id))) other.status = "superseded";
    }
  };

  const createApproval: Handler = ({ body }) => {
    const ids = parseAsk(body);
    if (!ids) return [400, { error: "Body needs pitch_ids (1 to 50 pitch ids) and origin (cli, mcp or agent_session)" }];
    const rejected = ids.map((id) => ({ id, reason: rejectionOf(id) })).filter((r) => r.reason !== null);
    if (rejected.length > 0) return [422, { error: "Some pitches cannot be approved now", rejected }];
    supersede(ids);
    const now = Date.now();
    const approval: FakeApproval = {
      id: uuid(0xf0, approvals.size + 1),
      code: CODES[approvals.size % CODES.length],
      status: "pending",
      items: ids.map((id) => {
        const row = queue.find((r) => r.id === id)!;
        return { pitch_id: id, to: row.to, subject: row.subject };
      }),
      result: null,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + approvalCtl.ttlMs).toISOString(),
      answered_at: null,
      answered_via: null,
    };
    approvals.set(approval.id, approval);
    const view = publicRequest(approval);
    return [201, { id: view.id, code: view.code, url: view.url, expires_at: view.expires_at, status: view.status }];
  };

  const readApproval: Handler = ({ params }) => {
    const found = approvals.get(params[0]);
    return found ? [200, publicRequest(expireIfDue(found))] : [404, { error: "Approval request not found" }];
  };

  const cancelApproval: Handler = ({ params }) => {
    const found = approvals.get(params[0]);
    if (!found) return [404, { error: "Approval request not found" }];
    const a = expireIfDue(found);
    if (a.status === "pending" && !a.answered_at) {
      a.status = "cancelled";
      return [200, publicRequest(a)];
    }
    return [409, { error: "This request can no longer be cancelled", request: publicRequest(a) }];
  };

  /** The signed-in person on the approve page. `claim` starts answering without finishing. */
  function answerApproval(id: string, answer: ApprovalAnswer) {
    const a = approvals.get(id);
    if (!a || a.status !== "pending") throw new Error(`approval ${id} is not pending`);
    a.answered_at = new Date().toISOString();
    a.answered_via = "web_session";
    if (answer === "claim") return;
    if (answer === "decline") {
      a.status = "declined";
      a.result = { approved: [], skipped: [] };
      return;
    }
    a.result = approvalResult(a, answer.skip ?? {});
    a.status = statusForResult(a.result);
    for (const row of queue) if (a.result.approved.includes(row.id)) row.state = "approved";
  }

  /** model.ts statusForResult. */
  const statusForResult = (r: NonNullable<FakeApproval["result"]>) => (r.skipped.length === 0 && r.approved.length > 0 ? "approved" : "partial");

  function approvalResult(a: FakeApproval, skip: Record<string, string>) {
    const approved = a.items.map((i) => i.pitch_id).filter((pid) => !(pid in skip));
    return { approved, skipped: Object.entries(skip).map(([id, reason]) => ({ id, reason })) };
  }

  const routes: Array<[string, RegExp, Handler]> = [
    ["POST", /^\/api\/v1\/approval-requests$/, createApproval],
    ["GET", /^\/api\/v1\/approval-requests\/([^/]+)$/, readApproval],
    ["POST", /^\/api\/v1\/approval-requests\/([^/]+)\/cancel$/, cancelApproval],
    ["GET", /^\/api\/v1\/campaigns$/, ({ query }) => {
      const rows = query.status ? [CAMPAIGN].filter((c) => c.status === query.status) : [CAMPAIGN];
      const { rows: pageRows, page, limit } = pageOf(rows, query);
      return [200, { campaigns: pageRows.map((c) => ({ ...c, contact_count: campaignContacts.length, created_at: iso(0) })), total: rows.length, page, limit }];
    }],
    ["GET", /^\/api\/v1\/campaigns\/([^/]+)$/, ({ params }) =>
      params[0] === CAMPAIGN_ID
        ? [200, { campaign: { ...CAMPAIGN, goal: "Daytime radio", created_at: iso(0), updated_at: iso(0) }, stats: { contact_count: 3, pitched_count: 1, replied_count: 0, coverage_count: 0 }, recent_activity: [] }]
        : [404, { error: "Campaign not found" }]],
    ["GET", /^\/api\/v1\/campaigns\/([^/]+)\/contacts$/, ({ query }) => {
      const { rows, page, limit } = pageOf(campaignContacts, query);
      return [200, { contacts: rows.map((r, i) => ({ campaign_contact_id: uuid(0xe0, i + 1), pitch_status: r.pitch_status, engagement_state: null, notes: null, added_at: iso(i), last_pitched_at: null, last_contacted_at: null, follow_up_due: null, contact: { id: r.contact.id, name: r.contact.name, email: r.contact.email, outlet: r.contact.outlet, role: r.contact.role, platform_type: r.contact.platform_type, enriched: r.contact.enriched, enriched_at: r.contact.enriched_at } })), total: campaignContacts.length, page, limit }];
    }],
    ["POST", /^\/api\/v1\/campaigns\/([^/]+)\/contacts$/, linkContacts],
    ["GET", /^\/api\/v1\/campaigns\/([^/]+)\/pitches$/, campaignPitches],
    ["POST", /^\/api\/v1\/campaigns\/([^/]+)\/pitches$/, ({ body }) => {
      const tone = (body as { tone?: string }).tone;
      const tones = tone ? [tone] : ["professional", "casual", "enthusiastic"];
      return [201, { drafts: [{ contact_id: contacts[0].id, contact_name: "Jo Presenter", variants: tones.map((t) => ({ subject: "Night Drive", body: `Hi Jo,\nNew single for you (${t}).`, tone: t })) }] }];
    }],
    ["GET", /^\/api\/v1\/outreach\/queue$/, outreachQueue],
    ["GET", /^\/api\/v1\/contacts$/, listContacts],
    ["POST", /^\/api\/v1\/contacts$/, importContacts],
    ["GET", /^\/api\/v1\/contacts\/([^/]+)$/, ({ params }) => {
      const contact = contacts.find((c) => c.id === params[0]);
      return contact ? [200, { contact }] : [404, { error: "Contact not found" }];
    }],
    ["POST", /^\/api\/v1\/contacts\/enrich$/, ({ body }) => {
      const ids = (body as { contactIds: string[] }).contactIds;
      return [200, { total: ids.length, enriched: ids.length, failed: 0, creditsUsed: ids.length, creditsRemaining: null, results: ids.map((contactId) => ({ contactId, status: "enriched" })) }];
    }],
    ["GET", /^\/api\/v1\/outcomes$/, ({ query }) => {
      const { page, limit } = pageOf([], query);
      return [200, { outcomes: [], total: 0, page, limit }];
    }],
    ["GET", /^\/api\/v1\/actions$/, () => [200, { actions: [], total: 0, generated_at: iso(0) }]],
  ];

  function handle(method: string, path: string, query: Record<string, string>, body: unknown): Reply {
    for (const [m, pattern, handler] of routes) {
      const match = method === m ? pattern.exec(path) : null;
      if (match) return handler({ query, body, params: match.slice(1).map(decodeURIComponent) });
    }
    return [404, { error: "Not found" }];
  }

  const APPROVAL_PATH = /^\/api\/v1\/approval-requests\/([^/]+)(\/cancel)?$/;

  /**
   * The request a call holds open: a GET while it is pending, or a cancel
   * while a person is answering (the cancel route's settledRow).
   */
  function heldApproval(method: string, path: string): FakeApproval | undefined {
    const match = APPROVAL_PATH.exec(path);
    const a = match ? approvals.get(match[1]) : undefined;
    if (!a || expireIfDue(a).status !== "pending") return undefined;
    if (match![2]) return method === "POST" && a.answered_at ? a : undefined;
    return method === "GET" ? a : undefined;
  }

  /** How long to hold the call. The fake polls each 100 ms; the routes poll each second. */
  function waitSeconds(method: string, path: string, query: Record<string, string>): number {
    if (!heldApproval(method, path)) return 0;
    if (path.endsWith("/cancel")) return 25;
    const raw = Number(query.wait ?? 0);
    return Number.isFinite(raw) ? Math.min(25, Math.max(0, Math.floor(raw))) : 0;
  }

  const stillHeld = (method: string, path: string) => Boolean(heldApproval(method, path));

  const faults: FaultRule[] = [];
  const served: Served[] = [];
  const net = { outage: false };

  const ruleMatches = (f: FaultRule, method: string, path: string, query: Record<string, string>) =>
    f.method === method && f.path.test(path) && Object.entries(f.query ?? {}).every(([k, v]) => query[k] === v);

  function takeFault(method: string, path: string, query: Record<string, string>): Fault | null {
    const index = faults.findIndex((f) => ruleMatches(f, method, path, query));
    if (index < 0) return null;
    const [rule] = faults.splice(index, 1);
    served.push({ rule, at: Date.now() });
    return rule.fault;
  }

  return { contacts, queue, approvals, approvalCtl, answerApproval, handle, waitSeconds, stillHeld, faults, served, net, takeFault };
}

/** The v1 gate's refusals (lib/api/api-key-auth.ts). */
const REFUSAL: Record<number, string> = { 401: "Invalid or missing API key", 403: "Insufficient scope: agents:read required" };

export async function startFakeTap(opts: FakeTapOptions = {}, port = 0) {
  const requests: Recorded[] = [];
  let state: ReturnType<typeof fakeTapState>;

  const send = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(payload));
  };

  /** Apply a fault, or return false to answer normally (after any delay). */
  function injected(fault: Fault | null, req: IncomingMessage, res: ServerResponse, answer: () => void): boolean {
    if (!fault) return false;
    if ("dropAfterMs" in fault) setTimeout(() => req.socket.destroy(), fault.dropAfterMs);
    else if ("delayMs" in fault) setTimeout(answer, fault.delayMs);
    else if (fault.status === 429) send(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": String(fault.retryAfter) });
    else send(res, fault.status, { error: REFUSAL[fault.status] ?? "Internal server error" });
    return true;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "";
      const query = Object.fromEntries(url.searchParams);
      const body = raw ? JSON.parse(raw) : undefined;
      const auth = req.headers.authorization;
      requests.push({ method, path: url.pathname, query, auth, body, at: Date.now() });
      if (state.net.outage) return req.socket.destroy();
      const reply = () => {
        const [status, payload] = auth === `Bearer ${NO_PLAN_KEY}` ? PLAN_REFUSAL : state.handle(method, url.pathname, query, body);
        send(res, status, payload);
      };
      const answer = () => {
        const deadline = Date.now() + state.waitSeconds(method, url.pathname, query) * 1000;
        const poll = () => {
          if (state.net.outage) return req.socket.destroy();
          return Date.now() < deadline && state.stillHeld(method, url.pathname) && !req.socket.destroyed ? setTimeout(poll, 100) : reply();
        };
        poll();
      };
      if (!injected(state.takeFault(method, url.pathname, query), req, res, answer)) answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state = fakeTapState(opts, url);

  return {
    url,
    requests,
    get state() {
      return state;
    },
    reset() {
      state = fakeTapState(opts, url);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
