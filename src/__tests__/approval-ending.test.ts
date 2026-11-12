import { describe, it, expect, vi, afterEach } from "vitest";
import { exitCodeOf, type Ending, type RequestRef } from "../lib/approval-session.js";
import { endingJson, renderEnding } from "../ui/approve-report.js";
import { LostTouch, retrying } from "../lib/retry.js";
import { TapApiError } from "../lib/rest.js";
import { parseApprovalRequest, type ApprovalRequest, type ApprovalStatus } from "../lib/approval-requests.js";

const ID = "0b6f7a52-1c1d-4e0a-9d3e-5a1f2c3b4d5e";
const STATUS_COMMAND = `tap approve status ${ID} --wait`;

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function request(status: ApprovalStatus, approved: number): ApprovalRequest {
  const items = [1, 2].map((n) => ({ pitch_id: `p${n}`, to: `dj${n}@example.com`, subject: `Pitch ${n}` }));
  const result = status === "pending" ? null : { approved: items.slice(0, approved).map((i) => i.pitch_id), skipped: items.slice(approved).map((i) => ({ id: i.pitch_id, reason: "not_selected" })) };
  return parseApprovalRequest({ id: ID, code: "K7QM", status, url: `https://tap.test/approve/${ID}`, origin: "cli", item_count: 2, items, result, created_at: at(-1), expires_at: at(14), answered_at: status === "pending" ? null : at(0), answered_via: null });
}

const refs: Record<string, RequestRef> = {
  open: { id: ID, code: "K7QM", url: `https://tap.test/approve/${ID}`, expires_at: at(14) },
  expired: { id: ID, code: "K7QM", url: `https://tap.test/approve/${ID}`, expires_at: at(-1) },
  "id only": { id: ID, code: null, url: null, expires_at: null },
};

const reasons = ["Could not reach TAP. Stopped waiting for the answer.", "TAP refused with 401: Invalid or missing API key. Stopped waiting for the answer.", "You quit before TAP confirmed an answer or a withdrawal.", "Could not reach TAP. Could not withdraw the request.", "You stopped watching. The request was not withdrawn."];

/** One of every ending, with left_open in every reason, stop state and amount of detail the CLI can hold. */
function everyEnding(): Array<{ ref: RequestRef; ending: Ending; exit: number }> {
  const statuses: ApprovalStatus[] = ["approved", "partial", "declined", "interrupted", "expired", "cancelled", "superseded"];
  const answered = statuses.flatMap((status) => [0, 1].map((n) => ({ ref: refs.open, ending: { kind: "answered", request: request(status, n) } as Ending, exit: n > 0 ? 0 : 1 })));
  const leftOpen = Object.values(refs).flatMap((ref) =>
    reasons.flatMap((reason) => [true, false].map((stopped) => ({ ref, ending: { kind: "left_open", reason, stopped } as Ending, exit: stopped ? 130 : 1 }))),
  );
  return [
    ...answered,
    { ref: refs.open, ending: { kind: "withdrawn", request: request("cancelled", 0) }, exit: 130 },
    { ref: refs.open, ending: { kind: "open", request: null }, exit: 0 },
    { ref: refs.open, ending: { kind: "open", request: request("pending", 0) }, exit: 0 },
    { ref: refs["id only"], ending: { kind: "gone" }, exit: 1 },
    ...leftOpen,
  ];
}

function rendered(ref: RequestRef, ending: Ending, json: boolean): string {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => void lines.push(args.join(" "));
  const log = vi.spyOn(console, "log").mockImplementation(capture);
  const error = vi.spyOn(console, "error").mockImplementation(capture);
  try {
    renderEnding(ref, ending, { json, qr: false, outlets: new Map(), campaign: { id: "c1" } });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return lines.join("\n");
}

const renderedText = (ref: RequestRef, ending: Ending) => rendered(ref, ending, false);

describe("every ending of a request", () => {
  it.each(everyEnding().map((c) => [`${c.ending.kind} ${JSON.stringify(c.ending).slice(0, 60)} ${c.ref.code ?? "id only"}`, c]))("%s renders and maps to its exit code", (_, c) => {
    const json = endingJson(c.ref, c.ending, "c1") as Record<string, unknown>;
    const text = renderedText(c.ref, c.ending);
    expect(json.outcome).toBe(c.ending.kind);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(text.length).toBeGreaterThan(0);
    expect(exitCodeOf(c.ending)).toBe(c.exit);
    if (c.ending.kind !== "gone") expect(text).toContain(STATUS_COMMAND);
    if (c.ending.kind !== "left_open") return;
    expect(text).toContain(ID);
    expect(text).toContain(STATUS_COMMAND);
    expect(text).toContain(c.ending.reason);
    expect(json).toMatchObject({ id: ID, status: "unknown", reason: c.ending.reason, status_command: STATUS_COMMAND, code: c.ref.code, url: c.ref.url, expires_at: c.ref.expires_at });
  });
});

describe("retrying", () => {
  afterEach(() => vi.useRealTimers());
  const blip = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") }));

  it("allows no retries when the deadline is not a date, instead of spinning", async () => {
    const op = vi.fn(blip);
    await expect(retrying(op, { until: Date.parse("not a date") })).rejects.toBeInstanceOf(LostTouch);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("stops waiting between attempts as soon as the signal aborts", async () => {
    const stop = new AbortController();
    const limited = () => Promise.reject(new TapApiError(429, "Rate limit exceeded", null, 60));
    const op = vi.fn(limited);
    let delay = 0;
    const run = retrying(op, { until: Date.now() + 120_000, signal: stop.signal, onRetry: (_, ms) => ((delay = ms), stop.abort()) });
    // A sleep the abort did not cut short would outlast the test's own timeout.
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(delay).toBe(60_000);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("passes the signal to the attempt, so an attempt in flight stops too", async () => {
    const stop = new AbortController();
    const op = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason)));
    const run = retrying(op, { until: Date.now() + 60_000, signal: stop.signal });
    stop.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});

/** A small seeded generator, so a failing case reruns the same. */
function prng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function junkValues(): unknown[] {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  return [undefined, null, 0, -1, NaN, 1.5, true, "", "x", "not-a-date", [], [null], [{}], {}, { approved: "x", skipped: 3 }, { approved: [null], skipped: [{}] }, 10n, circular, () => 1, Symbol("s")];
}

/** Every field of `base`, each replaced by junk in turn, and then every field junk at once. */
function junkedCopies(base: Record<string, unknown>, pick: () => unknown): Array<Record<string, unknown>> {
  const keys = Object.keys(base);
  const one = keys.flatMap((key) => junkValues().map((junk) => ({ ...base, [key]: junk })));
  const all = Array.from({ length: 40 }, () => Object.fromEntries(keys.map((key) => [key, pick()])));
  return [...one, ...all];
}

function junkEndings(): Ending[] {
  const random = prng(7);
  const values = junkValues();
  const pick = () => values[Math.floor(random() * values.length)];
  const answered = request("partial", 1) as unknown as Record<string, unknown>;
  const requests = [...junkedCopies(answered, pick), ...values];
  const withRequest = (kind: string) => requests.map((r) => ({ kind, request: r }));
  const leftOpen = junkedCopies({ reason: "Could not reach TAP", stopped: false }, pick).map((e) => ({ kind: "left_open", ...e }));
  return [...withRequest("answered"), ...withRequest("withdrawn"), ...withRequest("open"), ...leftOpen, { kind: "gone" }, ...values.map((kind) => ({ kind }))] as unknown as Ending[];
}

describe("renderEnding given junk in any field of any ending", () => {
  const ref = { id: ID, code: "K7QM", url: `https://tap.test/approve/${ID}`, expires_at: at(14) };
  const junkRefs = [ref, ...junkValues().map((junk) => ({ ...ref, code: junk, url: junk, expires_at: junk }))] as RequestRef[];
  const cases = junkEndings().flatMap((ending) => junkRefs.slice(0, 3).map((r) => ({ ref: r, ending })));
  cases.push(...junkRefs.map((r) => ({ ref: r, ending: { kind: "answered", request: request("approved", 2) } as Ending })));

  it(`never throws, and names the request and how to read it, in ${cases.length} cases as text`, () => {
    for (const { ref: r, ending } of cases) {
      const text = rendered(r, ending, false);
      expect(text).toContain(ID);
      if ((ending as { kind: unknown }).kind !== "gone") expect(text).toContain(STATUS_COMMAND);
    }
  });

  it(`prints exactly one JSON object naming the request, in ${cases.length} cases as JSON`, () => {
    for (const { ref: r, ending } of cases) {
      const parsed = JSON.parse(rendered(r, ending, true));
      expect(parsed.id ?? parsed.request?.id).toBe(ID);
      if ((ending as { kind: unknown }).kind !== "gone") expect(parsed.status_command).toBe(STATUS_COMMAND);
    }
  });
});
