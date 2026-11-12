import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeTap, CAMPAIGN_ID, type ApprovalAnswer } from "./fake-tap.js";
import { runTap, type RunOptions } from "./tap-process.js";

let tapServer: Awaited<ReturnType<typeof startFakeTap>>;

beforeAll(async () => {
  tapServer = await startFakeTap();
});
beforeEach(() => tapServer.reset());
afterAll(() => tapServer.close());

const T = 30_000;
const tap = (args: string[], opts: RunOptions = {}) => runTap(tapServer, args, opts);

const pendingIds = () => tapServer.state.queue.filter((r) => r.state === "pending_approval").map((r) => r.id);

/** The id of the request the CLI created, once it exists. */
async function asked(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const found = [...tapServer.state.approvals.values()].find((a) => a.status === "pending");
    if (found) return found.id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the CLI never created an approval request");
}

/** Answer as the signed-in person once the CLI is waiting. */
async function answerWhenAsked(answer: ApprovalAnswer): Promise<string> {
  const id = await asked();
  await new Promise((r) => setTimeout(r, 300));
  tapServer.state.answerApproval(id, answer);
  return id;
}

describe("tap approve asks a person and waits", () => {
  it("asks about every waiting pitch and reports all approved", async () => {
    const ids = pendingIds();
    const [run] = await Promise.all([tap(["approve", CAMPAIGN_ID, "--all"]), answerWhenAsked({})]);
    expect(run.code).toBe(0);
    expect(run.output).toContain("Code    K 7 Q M");
    expect(run.output).toContain(`${tapServer.url}/approve/`);
    expect(run.output).toContain("Approved 3 of 3");
    expect(run.output).toContain("BBC Radio 6 Music");
    expect(run.output).toContain(`tap send ${CAMPAIGN_ID}`);
    const post = run.calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({ path: "/api/v1/approval-requests", body: { pitch_ids: ids, origin: "cli" } });
    expect(run.calls.some((c) => c.method === "GET" && c.path.startsWith("/api/v1/approval-requests/") && c.query.wait === "25")).toBe(true);
  }, T);

  it("names each skipped pitch with the approve page's reason", async () => {
    const [, nts] = pendingIds();
    const [run] = await Promise.all([
      tap(["approve", CAMPAIGN_ID, "--all"]),
      answerWhenAsked({ skip: { [nts]: "already_pitched" } }),
    ]);
    expect(run.code).toBe(0);
    expect(run.output).toContain("Approved 2 of 3");
    expect(run.output).toMatch(/maya@nts\.live.*Already pitched/);
    expect(run.output).toContain("1 not approved");
  }, T);

  it("reports a decline and exits non-zero", async () => {
    const [run] = await Promise.all([tap(["approve", CAMPAIGN_ID, "--all"]), answerWhenAsked("decline")]);
    expect(run.code).toBe(1);
    expect(run.output).toContain("Declined. Nothing was approved or sent.");
    expect(run.output).toContain(`tap approve ${CAMPAIGN_ID}`);
  }, T);

  it("reports a request nobody answered as expired", async () => {
    tapServer.state.approvalCtl.ttlMs = 1500;
    const run = await tap(["approve", CAMPAIGN_ID, "--all"]);
    expect(run.code).toBe(1);
    expect(run.output).toContain("Nobody answered before the request expired");
  }, T);

  it("withdraws the request on Ctrl+C", async () => {
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) => void asked().then(() => setTimeout(() => child.kill("SIGINT"), 300)),
    });
    expect(run.code).toBe(1);
    expect(run.output).toContain("Withdrawn. Nothing was approved.");
    expect(run.calls.some((c) => c.method === "POST" && c.path.endsWith("/cancel"))).toBe(true);
    expect([...tapServer.state.approvals.values()][0].status).toBe("cancelled");
  }, T);

  it("keeps waiting when the withdrawal is refused because someone is answering", async () => {
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) =>
        void asked().then((id) => {
          tapServer.state.answerApproval(id, "claim");
          setTimeout(() => child.kill("SIGINT"), 300);
          setTimeout(() => tapServer.state.answerApproval(id, {}), 1200);
        }),
    });
    expect(run.calls.some((c) => c.path.endsWith("/cancel"))).toBe(true);
    expect(run.output).toContain("Approved 3 of 3");
    expect(run.code).toBe(0);
  }, T);

  it("explains a 422 per pitch and asks about nothing", async () => {
    const draft = tapServer.state.queue.find((r) => r.state === "draft")!;
    const run = await tap(["approve", CAMPAIGN_ID, "--pitch", draft.id, "--pitch", pendingIds()[0]]);
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/Still a draft.*Not waiting for approval/);
    expect(run.output).toContain("Nothing was asked");
    expect(tapServer.state.approvals.size).toBe(0);
  }, T);

  it("gives the 422 reasons as JSON", async () => {
    const draft = tapServer.state.queue.find((r) => r.state === "draft")!;
    const run = await tap(["approve", CAMPAIGN_ID, "--pitch", draft.id, "--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).rejected).toEqual([{ id: draft.id, reason: "not_pending", label: "Not waiting for approval" }]);
  }, T);

  it("prints the answer as JSON, keeping stdout for the JSON alone", async () => {
    const [run] = await Promise.all([tap(["approve", CAMPAIGN_ID, "--all", "--json"]), answerWhenAsked({})]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.request.status).toBe("approved");
    expect(parsed.request.result.approved).toHaveLength(3);
    expect(parsed.summary.headline).toBe("Approved 3 of 3");
    expect(run.stderr).toContain("Code K7QM");
  }, T);

  it("returns at once with --no-wait, then status reads and waits for the answer", async () => {
    const created = await tap(["approve", CAMPAIGN_ID, "--all", "--no-wait", "--json"]);
    expect(created.code).toBe(0);
    const { id, code, url, expires_at, status, status_command } = JSON.parse(created.stdout);
    expect({ code, status }).toEqual({ code: "K7QM", status: "pending" });
    expect(url).toBe(`${tapServer.url}/approve/${id}`);
    expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
    expect(status_command).toBe(`tap approve status ${id} --wait`);

    const pending = await tap(["approve", "status", id, "--json"]);
    expect(pending.code).toBe(0);
    expect(JSON.parse(pending.stdout).request.status).toBe("pending");

    setTimeout(() => tapServer.state.answerApproval(id, {}), 500);
    const answered = await tap(["approve", "status", id, "--wait"]);
    expect(answered.code).toBe(0);
    expect(answered.output).toContain("Approved 3 of 3");
  }, T);

  it("asks for --all or --pitch when it cannot show the picker", async () => {
    const run = await tap(["approve", CAMPAIGN_ID]);
    expect(run.code).toBe(1);
    expect(run.output).toContain("--all or --pitch <id>");
    expect(run.calls.every((c) => c.method === "GET")).toBe(true);
  }, T);

  it("says how to queue drafts when nothing waits for approval", async () => {
    for (const row of tapServer.state.queue) if (row.state === "pending_approval") row.state = "draft";
    const run = await tap(["approve", CAMPAIGN_ID, "--all"]);
    expect(run.code).toBe(1);
    expect(run.output).toContain("Nothing in this campaign is waiting for approval.");
    expect(run.output).toContain("4 drafts have not been queued for review yet.");
    expect(run.calls.every((c) => c.method === "GET")).toBe(true);
  }, T);
});
