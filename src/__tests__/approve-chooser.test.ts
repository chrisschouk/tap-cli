import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeTap, CAMPAIGN_ID } from "./fake-tap.js";
import { runTap, runTapPty, type PtyStep } from "./tap-process.js";

let tapServer: Awaited<ReturnType<typeof startFakeTap>>;

beforeAll(async () => {
  tapServer = await startFakeTap({ extraWaiting: 50 });
});
beforeEach(() => tapServer.reset());
afterAll(() => tapServer.close());

const T = 40_000;
const CHOOSER = "Choose the pitches to ask about";
const pending = () => tapServer.state.queue.filter((r) => r.state === "pending_approval").map((r) => r.id);
const chooser = (steps: PtyStep[]) => runTapPty(tapServer, ["approve", CAMPAIGN_ID, "--no-wait"], [{ wait: CHOOSER }, ...steps]);
const downs = (n: number): PtyStep[] => Array.from({ length: n }, () => ({ send: "j" }));

describe("tap approve with more than 50 waiting", () => {
  it("asks about the first 50 and says how to ask about the rest", async () => {
    const run = await runTap(tapServer, ["approve", CAMPAIGN_ID, "--all", "--no-wait"]);
    expect(run.code).toBe(0);
    expect(run.output).toContain("so this asks about the first 50 of 53.");
    expect(run.output).toContain(`Once it is answered, run tap approve ${CAMPAIGN_ID} --all to ask about the other 3.`);
    expect(run.output).toMatch(/Asked\s+50 of 53 pitches, request K7QM/);
    expect((run.calls.find((c) => c.method === "POST")?.body as { pitch_ids: string[] }).pitch_ids).toEqual(pending().slice(0, 50));
  }, T);
});

describe("the chooser in a 24-row terminal", () => {
  it("leaves out a toggled pitch and asks about the rest", async () => {
    const run = await chooser([{ send: "j" }, { send: " " }, { wait: "52 of 53 chosen" }, { send: "\r" }, { wait: "Check the answer" }]);
    expect(run.code).toBe(0);
    const ids = pending();
    expect((run.calls.find((c) => c.method === "POST")?.body as { pitch_ids: string[] }).pitch_ids).toEqual(ids.slice(0, 1).concat(ids.slice(2, 51)));
  }, T);

  it("reads a whole pitch, says what it leaves out, and goes back", async () => {
    const run = await chooser([{ send: "r" }, { wait: "I think it would sit well on your show." }, { wait: "the release block TAP adds" }, { send: "r" }, { wait: "TAP lists who each pitch goes to" }, { send: "q" }]);
    expect(run.code).toBe(130);
    expect(run.stdout).toContain("Not shown here: the release block TAP adds below the body, and the sender.");
  }, T);

  it("scrolls to pitches below the fold", async () => {
    const run = await chooser([...downs(40), { wait: "Pitch 38 for" }, { send: "q" }]);
    expect(run.code).toBe(130);
    expect(run.stdout).toMatch(/↑ \d+ more/);
    expect(run.stdout).toMatch(/↓ \d+ more/);
  }, T);

  it("quits with q, asks nothing and exits 130", async () => {
    const run = await chooser([{ send: "q" }]);
    expect(run.code).toBe(130);
    expect(tapServer.state.approvals.size).toBe(0);
    expect(run.calls.some((c) => c.method === "POST")).toBe(false);
  }, T);
});
