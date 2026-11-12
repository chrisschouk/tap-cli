import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeTap, type Fault } from "./fake-tap.js";
import {
  createApprovalRequest,
  createMayHaveLanded,
  isFinal,
  parseApprovalRequest,
  parseCreated,
  type ApprovalStatus,
  type CreatedRequest,
} from "../lib/approval-requests.js";
import { MalformedReply } from "../lib/rest.js";
import { StopRequest, settle, type Ending, type SessionView } from "../lib/approval-session.js";

let tapServer: Awaited<ReturnType<typeof startFakeTap>>;

beforeAll(async () => {
  tapServer = await startFakeTap();
  process.env.TAP_URL = tapServer.url;
  process.env.TAP_API_KEY = "tap_ak_test";
});
beforeEach(() => tapServer.reset());
afterAll(() => tapServer.close());

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const ID = "000000f0-0000-4000-8000-000000000001";
const valid = {
  id: ID,
  code: "K7QM",
  status: "partial",
  url: `https://tap.test/approve/${ID}`,
  origin: "cli",
  item_count: 1,
  items: [{ pitch_id: "p1", to: "jo@example.com", subject: null }],
  result: { approved: [], skipped: [{ id: "p1", reason: "already_pitched" }] },
  created_at: at(-1),
  expires_at: at(14),
  answered_at: at(0),
  answered_via: "web_session",
};

describe("parsing an approval request reply", () => {
  it("accepts TAP's publicRequest shape", () => {
    expect(parseApprovalRequest(valid)).toMatchObject({ id: ID, status: "partial" });
    expect(parseCreated(valid)).toEqual({ id: ID, code: "K7QM", url: valid.url, expires_at: valid.expires_at });
  });

  it.each([
    ["an empty or non-JSON body, which rest hands over as {}", {}, "it has no valid id"],
    ["a body that is not an object", "<html>proxy</html>", "it is not a JSON object"],
    ["null", null, "it is not a JSON object"],
    ["an empty id", { ...valid, id: "" }, "it has no valid id"],
    ["an expiry that is not a date", { ...valid, expires_at: "not-a-date" }, "it has no valid expires_at"],
    ["no expiry", { ...valid, expires_at: undefined }, "it has no valid expires_at"],
    ["a result with the wrong arrays", { ...valid, result: { approved: "x", skipped: 3 } }, "it has no valid result"],
    ["skips without reasons", { ...valid, result: { approved: [], skipped: [{ id: "p1" }] } }, "it has no valid result"],
    ["items that are not pitches", { ...valid, items: [{}] }, "it has no valid items"],
    ["a count that is not a count", { ...valid, item_count: -1 }, "it has no valid item_count"],
    ["no status", { ...valid, status: undefined }, "it has no valid status"],
    ["a status this CLI does not know", { ...valid, status: "reviewing" }, 'status "reviewing" is not one this CLI knows'],
  ])("refuses %s", (_, raw, detail) => {
    expect(() => parseApprovalRequest(raw)).toThrow(new MalformedReply(detail));
  });

  it("needs only the id, code, link and expiry from a create reply", () => {
    expect(() => parseCreated({ ...valid, status: "reviewing", result: 3 })).not.toThrow();
    expect(() => parseCreated({ ...valid, code: null })).toThrow(new MalformedReply("it has no valid code"));
  });

  it("calls only the known final statuses final", () => {
    const finals: ApprovalStatus[] = ["approved", "partial", "declined", "interrupted", "expired", "cancelled", "superseded"];
    for (const status of finals) expect(isFinal({ status })).toBe(true);
    expect(isFinal({ status: "pending" })).toBe(false);
    expect(isFinal({ status: "reviewing" as ApprovalStatus })).toBe(false);
  });
});

type Payload = Record<string, unknown>;
/** Edit the request, nested under `request` in a refused cancel's 409. */
const editRequest = (edit: (request: Payload) => Payload): Fault => ({ edit: (p) => ("request" in p ? { ...p, request: edit(p.request as Payload) } : edit(p)) });

const BAD_BODIES: Record<string, Fault> = {
  empty: { body: "" },
  "not JSON": { body: "{not json" },
  "a proxy's HTML": { body: "<html>proxy</html>" },
  "{}": { body: "{}" },
  "an unknown status": editRequest((p) => ({ ...p, status: "reviewing" })),
  "a malformed result": editRequest((p) => ({ ...p, status: "partial", result: { approved: "x", skipped: 3 } })),
};

const REQUEST_PATH = /^\/api\/v1\/approval-requests\/[^/]+$/;
const CANCEL_PATH = /^\/api\/v1\/approval-requests\/[^/]+\/cancel$/;
const CREATE_PATH = /^\/api\/v1\/approval-requests$/;

const pitchIds = () => tapServer.state.queue.filter((r) => r.state === "pending_approval").map((r) => r.id);

function view(): SessionView & { retries: string[] } {
  const retries: string[] = [];
  return { retries, note: () => {}, hooks: { onRetry: (reason) => void retries.push(reason) } };
}

async function created(): Promise<CreatedRequest> {
  return createApprovalRequest(pitchIds());
}

describe.each(Object.entries(BAD_BODIES))("a reply with %s", (name, fault) => {
  const malformed = !("edit" in fault);

  it(malformed ? "on create is a MalformedReply TAP may have acted on" : "on create still gives the request, which reads then judge", async () => {
    tapServer.state.faults.push({ method: "POST", path: CREATE_PATH, fault });
    const ask = createApprovalRequest(pitchIds());
    if (!malformed) return expect((await ask).id).toBe(ID);
    const err = await ask.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedReply);
    expect(createMayHaveLanded(err)).toBe(true);
  });

  it("while waiting is retried, then leaves the request open saying TAP's reply was not understood", async () => {
    tapServer.state.approvalCtl.ttlMs = 2500;
    const request = await created();
    tapServer.state.faults.push({ method: "GET", path: REQUEST_PATH, fault, sticky: true });
    const v = view();
    const ending = await settle(request, new StopRequest(), v);
    expect(ending).toMatchObject({ kind: "left_open", stopped: false });
    const reason = (ending as Extract<Ending, { kind: "left_open" }>).reason;
    expect(reason).toMatch(/^TAP's reply was not understood: .*\. Stopped waiting for the answer\.$/);
    if (name === "an unknown status") expect(reason).toContain('status "reviewing"');
    expect(v.retries.length).toBeGreaterThan(0);
  }, 15_000);

  it("on withdraw is retried, then says the request could not be withdrawn", async () => {
    tapServer.state.approvalCtl.ttlMs = 2500;
    const request = await created();
    tapServer.state.faults.push({ method: "POST", path: CANCEL_PATH, fault, sticky: true });
    const stop = new StopRequest();
    stop.press();
    const ending = await settle(request, stop, view());
    expect(ending).toMatchObject({ kind: "left_open", stopped: true });
    expect((ending as Extract<Ending, { kind: "left_open" }>).reason).toMatch(/^TAP's reply was not understood: .*\. Could not withdraw the request\.$/);
  }, 15_000);
});

describe("a reply TAP gets right on the next try", () => {
  it("heals: the wait carries on and reports the answer", async () => {
    const request = await created();
    tapServer.state.faults.push({ method: "GET", path: REQUEST_PATH, query: { wait: "25" }, fault: BAD_BODIES["an unknown status"] });
    const v = view();
    const answering = (async () => {
      for (let i = 0; i < 200 && tapServer.requests.filter((r) => r.query.wait === "25").length < 2; i++) await new Promise((r) => setTimeout(r, 50));
      tapServer.state.answerApproval(request.id, {});
    })();
    const ending = await settle(request, new StopRequest(), v);
    await answering;
    expect(ending).toMatchObject({ kind: "answered", request: { status: "approved" } });
    expect(v.retries).toEqual(['TAP\'s reply was not understood: status "reviewing" is not one this CLI knows']);
  }, 15_000);
});

describe("a create TAP does not answer in time", () => {
  it("times out on the injected limit and counts as maybe created", async () => {
    tapServer.state.faults.push({ method: "POST", path: CREATE_PATH, fault: { delayMs: 1500 } });
    const err = await createApprovalRequest(pitchIds(), undefined, 200).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "TimeoutError" });
    expect(createMayHaveLanded(err)).toBe(true);
  });
});
