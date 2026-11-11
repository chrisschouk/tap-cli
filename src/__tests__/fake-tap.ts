/**
 * A fake TAP REST v1 server for CLI tests and demos. Response shapes, limits
 * and query handling are copied from the route handlers in
 * total-audio-platform/apps/tap/app/api/v1 (select lists, `limit` clamped to
 * 200, `updated_at desc` ordering on the outreach queue, 500 contacts per
 * import, 200 contact ids per campaign link, results capped at 100).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | undefined;
  body: unknown;
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
  state: string;
  send_status: string;
  scheduled_for: string | null;
  updated_at: string;
}

type Reply = [number, unknown];
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

function seedContacts(count: number): Contact[] {
  return Array.from({ length: count }, (_, i) => ({
    id: uuid(0xc0, i + 1),
    name: i === 0 ? "Jo Presenter" : `Contact ${i + 1}`,
    email: i === 0 ? "jo@bbc.co.uk" : `contact${i + 1}@example.com`,
    outlet: i === 0 ? "BBC Radio 6 Music" : `Outlet ${i + 1}`,
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
    state: "sent",
    send_status: "sent",
    scheduled_for: null,
    updated_at: iso(i),
  }));
  const waiting: QueueRow[] = [
    { id: uuid(0xb0, 1), subject: "Night Drive for your Friday show", state: "pending_approval", send_status: "draft", scheduled_for: null, updated_at: iso(sent + 1) },
    { id: uuid(0xb0, 2), subject: "Approved already", state: "approved", send_status: "draft", scheduled_for: "2026-11-12T09:00:00Z", updated_at: iso(sent + 2) },
    { id: uuid(0xb0, 3), subject: "Gmail refused this one", state: "approved", send_status: "failed", scheduled_for: null, updated_at: iso(sent + 3) },
    { id: uuid(0xb0, 4), subject: "Waiting on the release pack", state: "approved", send_status: "held_for_payment", scheduled_for: null, updated_at: iso(sent + 4) },
    { id: uuid(0xb0, 5), subject: "Still a draft", state: "draft", send_status: "draft", scheduled_for: null, updated_at: iso(sent + 5) },
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
}

export function fakeTapState(opts: FakeTapOptions = {}) {
  const contacts = seedContacts(opts.contacts ?? 230);
  const queue = seedQueue(opts.sentPitches ?? 220);
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

  const campaignPitches: Handler = () => [
    200,
    {
      pitches: queue.map((r) => ({
        id: r.id,
        title: null,
        subject: r.subject,
        body: "",
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

  const routes: Array<[string, RegExp, Handler]> = [
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

  return { contacts, queue, handle };
}

export async function startFakeTap(opts: FakeTapOptions = {}, port = 0) {
  let state = fakeTapState(opts);
  const requests: Recorded[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const query = Object.fromEntries(url.searchParams);
      const body = raw ? JSON.parse(raw) : undefined;
      const auth = req.headers.authorization;
      requests.push({ method: req.method ?? "", path: url.pathname, query, auth, body });
      const [status, payload] =
        auth === `Bearer ${NO_PLAN_KEY}` ? PLAN_REFUSAL : state.handle(req.method ?? "", url.pathname, query, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    get state() {
      return state;
    },
    reset() {
      state = fakeTapState(opts);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
