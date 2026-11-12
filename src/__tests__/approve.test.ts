import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeTap, CAMPAIGN_ID, type ApprovalAnswer, type Recorded } from "./fake-tap.js";
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

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`never happened: ${what}`);
}

const REQUEST_PATH = /^\/api\/v1\/approval-requests\/[^/]+$/;
const requestReads = (calls: Recorded[]) => calls.filter((c) => c.method === "GET" && REQUEST_PATH.test(c.path));
const onlyApproval = () => [...tapServer.state.approvals.values()][0];

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

  it("withdraws the request on Ctrl+C and exits 130", async () => {
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) => void asked().then(() => setTimeout(() => child.kill("SIGINT"), 300)),
    });
    expect(run.code).toBe(130);
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

  it("lists the drafts and links to the TAP page that sends them for approval when nothing waits", async () => {
    for (const row of tapServer.state.queue) if (row.state === "pending_approval") row.state = "draft";
    const run = await tap(["approve", CAMPAIGN_ID, "--all"]);
    expect(run.code).toBe(1);
    expect(run.output).toContain("Nothing in this campaign is waiting for approval.");
    expect(run.output).toContain("Still a draft");
    expect(run.output).toContain("These 4 drafts have not been sent for approval. Send them for approval in TAP");
    expect(run.output).toContain(`${tapServer.url}/releases/${CAMPAIGN_ID}?tab=pitching`);
    expect(run.calls.every((c) => c.method === "GET")).toBe(true);

    const json = await tap(["approve", CAMPAIGN_ID, "--all", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ review_url: `${tapServer.url}/releases/${CAMPAIGN_ID}?tab=pitching` });
    expect(JSON.parse(json.stdout).drafts).toHaveLength(4);
  }, T);

  it("asks once about a pitch named twice", async () => {
    const [jo] = pendingIds();
    const run = await tap(["approve", CAMPAIGN_ID, "--pitch", jo, "--pitch", jo, "--no-wait", "--json"]);
    expect(run.code).toBe(0);
    expect(run.calls.find((c) => c.method === "POST")?.body).toEqual({ pitch_ids: [jo], origin: "cli" });
  }, T);

  it("does not say TAP sends anything when every pitch was skipped", async () => {
    const skip = Object.fromEntries(pendingIds().map((id) => [id, "already_pitched"]));
    const [run] = await Promise.all([tap(["approve", CAMPAIGN_ID, "--all"]), answerWhenAsked({ skip })]);
    expect(run.code).toBe(1);
    expect(run.output).toContain("Every pitch was skipped. Nothing was approved or sent.");
    expect(run.output).not.toContain("TAP sends");
  }, T);
});

describe("tap approve does not orphan a request", () => {
  it("rides out a 503, a dropped connection and a 429 with Retry-After, then reports the answer", async () => {
    tapServer.state.faults.push(
      { method: "GET", path: REQUEST_PATH, fault: { status: 503 } },
      { method: "GET", path: REQUEST_PATH, fault: { dropAfterMs: 300 } },
      { method: "GET", path: REQUEST_PATH, fault: { status: 429, retryAfter: 2 } },
    );
    const answer = async () => {
      const id = await asked();
      await until(() => tapServer.state.faults.length === 0, "every fault played");
      await new Promise((r) => setTimeout(r, 2500));
      tapServer.state.answerApproval(id, {});
    };
    const [run] = await Promise.all([tap(["approve", CAMPAIGN_ID, "--all"]), answer()]);
    expect(run.code).toBe(0);
    expect(run.output).toContain("Approved 3 of 3");
    expect(run.output).toContain("TAP answered 503. Trying again in 1s");
    expect(run.output).toContain("Could not reach TAP. Trying again in 2s");
    expect(run.output).toContain("TAP answered 429. Trying again in 2s");
    expect(run.output).toContain("Back in touch with TAP.");
    const reads = requestReads(run.calls);
    expect(reads.length).toBeGreaterThanOrEqual(4);
    expect(reads[3].at - reads[2].at).toBeGreaterThanOrEqual(1900);
    expect(run.calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
  }, T);

  it("says the request was not withdrawn when TAP stays unreachable, with the id, code, link and status command", async () => {
    tapServer.state.approvalCtl.ttlMs = 4000;
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: () => void asked().then(() => setTimeout(() => (tapServer.state.net.outage = true), 800)),
    });
    const { id, code } = onlyApproval();
    expect(run.code).toBe(1);
    expect(run.output).toContain("Could not reach TAP. Stopped waiting for the answer.");
    expect(run.output).toMatch(/A person may have approved it before then, and TAP sends what they approved/);
    expect(run.output).toContain(id);
    expect(run.output).toContain(code);
    expect(run.output).toContain(`${tapServer.url}/approve/${id}`);
    expect(run.output).toContain(`tap approve status ${id} --wait`);
    expect(run.calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
  }, T);

  it("gives up as JSON with status unknown and the status command", async () => {
    tapServer.state.approvalCtl.ttlMs = 3000;
    const run = await tap(["approve", CAMPAIGN_ID, "--all", "--json"], {
      onSpawn: () => void asked().then(() => (tapServer.state.net.outage = true)),
    });
    const { id } = onlyApproval();
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ id, status: "unknown", status_command: `tap approve status ${id} --wait` });
  }, T);

  it.each(["SIGTERM", "SIGHUP"] as const)("withdraws on %s like Ctrl+C", async (signal) => {
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) => void asked().then(() => setTimeout(() => child.kill(signal), 300)),
    });
    expect(run.code).toBe(130);
    expect(onlyApproval().status).toBe("cancelled");
  }, T);

  it("withdraws a request whose create was interrupted, once TAP returns its id", async () => {
    tapServer.state.faults.push({ method: "POST", path: /^\/api\/v1\/approval-requests$/, fault: { delayMs: 1500 } });
    const before = tapServer.requests.length;
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) =>
        void until(() => tapServer.requests.slice(before).some((r) => r.method === "POST"), "the create arrived").then(() => child.kill("SIGINT")),
    });
    expect(run.code).toBe(130);
    expect(run.output).toContain("Stopping. The request will be withdrawn.");
    expect(run.output).toContain("Withdrawn. Nothing was approved.");
    expect(onlyApproval().status).toBe("cancelled");
  }, T);

  it("withdraws when interrupted while the asked pitches load", async () => {
    tapServer.state.faults.push({ method: "GET", path: REQUEST_PATH, fault: { delayMs: 1500 } });
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) => void asked().then(() => setTimeout(() => child.kill("SIGINT"), 200)),
    });
    expect(run.code).toBe(130);
    expect(onlyApproval().status).toBe("cancelled");
  }, T);
});
