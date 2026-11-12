import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startFakeTap, CAMPAIGN_ID, type ApprovalAnswer, type Recorded } from "./fake-tap.js";
import { runTap, type RunOptions } from "./tap-process.js";

let tapServer: Awaited<ReturnType<typeof startFakeTap>>;
let mark = 0;

beforeAll(async () => {
  tapServer = await startFakeTap();
});
beforeEach(() => {
  tapServer.reset();
  mark = tapServer.requests.length;
});
afterAll(() => tapServer.close());

const T = 30_000;
const tap = (args: string[], opts: RunOptions = {}) => runTap(tapServer, args, opts);

const pendingIds = () => tapServer.state.queue.filter((r) => r.state === "pending_approval").map((r) => r.id);

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`never happened: ${what}`);
}

/** The id of the request the CLI created, once it exists. */
async function asked(): Promise<string> {
  await until(() => [...tapServer.state.approvals.values()].some((a) => a.status === "pending"), "the CLI created an approval request");
  return [...tapServer.state.approvals.values()].find((a) => a.status === "pending")!.id;
}

const REQUEST_PATH = /^\/api\/v1\/approval-requests\/[^/]+$/;
const CANCEL_PATH = /^\/api\/v1\/approval-requests\/[^/]+\/cancel$/;
const CREATE_PATH = /^\/api\/v1\/approval-requests$/;
const sinceMark = () => tapServer.requests.slice(mark);
const requestReads = (calls: Recorded[]) => calls.filter((c) => c.method === "GET" && REQUEST_PATH.test(c.path));
const cancels = (calls: Recorded[]) => calls.filter((c) => c.method === "POST" && CANCEL_PATH.test(c.path));
const onlyApproval = () => [...tapServer.state.approvals.values()][0];
const longPolling = () => requestReads(sinceMark()).some((c) => c.query.wait === "25");
const cancelArrived = () => cancels(sinceMark()).length > 0;

/** The CLI is holding a long poll on the request: it has shown the ask and is waiting. */
async function waitingOnAnswer(): Promise<string> {
  const id = await asked();
  await until(longPolling, "the CLI started waiting for the answer");
  return id;
}

/** Answer as the signed-in person once the CLI is waiting. */
async function answerWhenAsked(answer: ApprovalAnswer): Promise<string> {
  const id = await waitingOnAnswer();
  tapServer.state.answerApproval(id, answer);
  return id;
}

/** What every report of a request left open must carry. */
function expectLeftOpenText(output: string, id: string) {
  const { code } = onlyApproval();
  expect(output).toContain(id);
  expect(output).toContain(code);
  expect(output).toContain(`${tapServer.url}/approve/${id}`);
  expect(output).toMatch(/Expires\s+\d\d:\d\d/);
  expect(output).toContain(`tap approve status ${id} --wait`);
}

function expectLeftOpenJson(stdout: string, id: string) {
  const { code, expires_at } = onlyApproval();
  const parsed = JSON.parse(stdout);
  expect(parsed).toMatchObject({ outcome: "left_open", id, code, url: `${tapServer.url}/approve/${id}`, expires_at, status: "unknown", status_command: `tap approve status ${id} --wait` });
  expect(typeof parsed.reason).toBe("string");
  return parsed as { reason: string };
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
      onSpawn: (child) => void waitingOnAnswer().then(() => child.kill("SIGINT")),
    });
    expect(run.code).toBe(130);
    expect(run.output).toContain("Withdrawn. Nothing was approved.");
    expect(run.calls.some((c) => c.method === "POST" && c.path.endsWith("/cancel"))).toBe(true);
    expect([...tapServer.state.approvals.values()][0].status).toBe("cancelled");
  }, T);

  it("keeps waiting when the withdrawal is refused because someone is answering", async () => {
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) =>
        void waitingOnAnswer().then(async (id) => {
          tapServer.state.answerApproval(id, "claim");
          child.kill("SIGINT");
          await until(cancelArrived, "the CLI asked to withdraw");
          tapServer.state.answerApproval(id, {});
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

    mark = tapServer.requests.length;
    const [answered] = await Promise.all([
      tap(["approve", "status", id, "--wait"]),
      until(longPolling, "status started waiting").then(() => tapServer.state.answerApproval(id, {})),
    ]);
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
    const servedRateLimit = () => tapServer.state.served.find((s) => "status" in s.rule.fault && s.rule.fault.status === 429);
    const retriedAfter = () => {
      const limited = servedRateLimit();
      return limited ? requestReads(sinceMark()).find((c) => c.at > limited.at) : undefined;
    };
    const answer = async () => {
      const id = await asked();
      await until(() => retriedAfter() !== undefined, "the CLI read again after the 429");
      tapServer.state.answerApproval(id, {});
    };
    const [run] = await Promise.all([tap(["approve", CAMPAIGN_ID, "--all"]), answer()]);
    expect(run.code).toBe(0);
    expect(run.output).toContain("Approved 3 of 3");
    expect(run.output).toContain("TAP answered 503. Trying again in 1s");
    expect(run.output).toContain("Could not reach TAP. Trying again in 2s");
    expect(run.output).toContain("TAP answered 429. Trying again in 2s");
    expect(run.output).toContain("Back in touch with TAP.");
    expect(retriedAfter()!.at - servedRateLimit()!.at).toBeGreaterThanOrEqual(2000);
    expect(cancels(run.calls)).toHaveLength(0);
  }, T);

  it("says the request was not withdrawn when TAP stays unreachable, with the id, code, link and status command", async () => {
    tapServer.state.approvalCtl.ttlMs = 4000;
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: () => void waitingOnAnswer().then(() => (tapServer.state.net.outage = true)),
    });
    const { id } = onlyApproval();
    expect(run.code).toBe(1);
    expect(run.output).toContain("Could not reach TAP. Stopped waiting for the answer.");
    expect(run.output).toMatch(/A person may have approved it before then, and TAP sends what they approved/);
    expectLeftOpenText(run.output, id);
    expect(cancels(run.calls)).toHaveLength(0);
  }, T);

  it("gives up as JSON with status unknown and the status command", async () => {
    tapServer.state.approvalCtl.ttlMs = 3000;
    const run = await tap(["approve", CAMPAIGN_ID, "--all", "--json"], {
      onSpawn: () => void asked().then(() => (tapServer.state.net.outage = true)),
    });
    expect(run.code).toBe(1);
    expect(expectLeftOpenJson(run.stdout, onlyApproval().id).reason).toBe("Could not reach TAP. Stopped waiting for the answer.");
  }, T);

  it.each(["SIGTERM", "SIGHUP"] as const)("withdraws on %s like Ctrl+C", async (signal) => {
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) => void waitingOnAnswer().then(() => child.kill(signal)),
    });
    expect(run.code).toBe(130);
    expect(onlyApproval().status).toBe("cancelled");
  }, T);

  it("withdraws a request whose create was interrupted, once TAP returns its id", async () => {
    tapServer.state.faults.push({ method: "POST", path: /^\/api\/v1\/approval-requests$/, fault: { delayMs: 1500 } });
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) =>
        void until(() => sinceMark().some((r) => r.method === "POST"), "the create arrived").then(() => child.kill("SIGINT")),
    });
    expect(run.code).toBe(130);
    expect(run.output).toContain("Stopping. The request will be withdrawn once TAP returns it.");
    expect(run.output).toContain("Withdrawn. Nothing was approved.");
    expect(onlyApproval().status).toBe("cancelled");
  }, T);

  it("withdraws when interrupted while the asked pitches load", async () => {
    tapServer.state.faults.push({ method: "GET", path: REQUEST_PATH, fault: { delayMs: 1500 } });
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) => void asked().then(() => child.kill("SIGINT")),
    });
    expect(run.code).toBe(130);
    expect(onlyApproval().status).toBe("cancelled");
  }, T);
});

describe("every way out once the request exists names it and how to read it", () => {
  const LONG_POLL = { method: "GET", path: REQUEST_PATH, query: { wait: "25" } };

  it.each([401, 403] as const)("a %d while waiting leaves the request open and says so", async (status) => {
    tapServer.state.faults.push({ ...LONG_POLL, fault: { status } });
    const run = await tap(["approve", CAMPAIGN_ID, "--all"]);
    const { id } = onlyApproval();
    expect(run.code).toBe(1);
    expect(run.output).toContain(`TAP refused with ${status}`);
    expect(run.output).toContain("Stopped waiting for the answer.");
    expect(run.output).toContain("The request is still open until");
    expectLeftOpenText(run.output, id);
    expect(onlyApproval().status).toBe("pending");
    expect(cancels(run.calls)).toHaveLength(0);
  }, T);

  it.each([401, 403] as const)("a %d while waiting gives the open request as JSON on stdout", async (status) => {
    tapServer.state.faults.push({ ...LONG_POLL, fault: { status } });
    const run = await tap(["approve", CAMPAIGN_ID, "--all", "--json"]);
    expect(run.code).toBe(1);
    expect(expectLeftOpenJson(run.stdout, onlyApproval().id).reason).toContain(`TAP refused with ${status}`);
    expect(onlyApproval().status).toBe("pending");
  }, T);

  it("a second interrupt during a slow withdrawal quits at once and still names the request", async () => {
    tapServer.state.faults.push({ method: "POST", path: CANCEL_PATH, fault: { delayMs: 3000 } });
    let statusAtExit = "";
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) => {
        child.on("exit", () => (statusAtExit = onlyApproval().status));
        void waitingOnAnswer().then(async () => {
          child.kill("SIGINT");
          await until(cancelArrived, "the CLI asked to withdraw");
          child.kill("SIGINT");
        });
      },
    });
    const { id } = onlyApproval();
    expect(run.code).toBe(130);
    expect(statusAtExit).toBe("pending");
    expect(run.output).toContain("You quit before TAP confirmed an answer or a withdrawal.");
    expectLeftOpenText(run.output, id);
    await until(() => onlyApproval().status === "cancelled", "the slow withdrawal landed");
  }, T);

  it("an interrupt while TAP is down and the ask is loading tries to withdraw, then says the request is still open", async () => {
    tapServer.state.approvalCtl.ttlMs = 4000;
    const started = Date.now();
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) =>
        void asked().then(async () => {
          tapServer.state.net.outage = true;
          await until(() => requestReads(sinceMark()).length > 0, "the CLI tried to read the ask");
          child.kill("SIGINT");
        }),
    });
    const { id } = onlyApproval();
    expect(run.code).toBe(130);
    expect(cancels(run.calls).length).toBeGreaterThan(0);
    expect(run.output).toContain("Could not reach TAP. Could not withdraw the request.");
    expectLeftOpenText(run.output, id);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(onlyApproval().status).not.toBe("cancelled");
  }, T);

  it("a second interrupt while TAP is down quits without waiting for the withdrawal to give up", async () => {
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) =>
        void asked().then(async () => {
          tapServer.state.net.outage = true;
          await until(() => requestReads(sinceMark()).length > 0, "the CLI tried to read the ask");
          child.kill("SIGINT");
          await until(cancelArrived, "the CLI tried to withdraw");
          child.kill("SIGINT");
        }),
    });
    expect(run.code).toBe(130);
    expect(run.output).toContain("You quit before TAP confirmed an answer or a withdrawal.");
    expectLeftOpenText(run.output, onlyApproval().id);
    expect(onlyApproval().status).toBe("pending");
  }, T);

  it("quitting while the create is in flight says TAP may have created the request and where to look", async () => {
    tapServer.state.faults.push({ method: "POST", path: CREATE_PATH, fault: { delayMs: 1500 } });
    const run = await tap(["approve", CAMPAIGN_ID, "--all"], {
      onSpawn: (child) => {
        let stderr = "";
        child.stderr!.on("data", (d) => (stderr += d));
        void until(() => sinceMark().some((r) => r.method === "POST"), "the create arrived").then(async () => {
          child.kill("SIGINT");
          await until(() => stderr.includes("Stopping."), "the CLI took the first interrupt");
          child.kill("SIGINT");
        });
      },
    });
    expect(run.code).toBe(130);
    expect(run.output).toContain("You quit before TAP answered. TAP may have created the request anyway.");
    expect(run.output).toContain(`${tapServer.url}/releases/${CAMPAIGN_ID}?tab=pitching`);
    await until(() => tapServer.state.approvals.size === 1, "the slow create landed");
  }, T);

  it("gives up on a create TAP does not answer and says it may exist", async () => {
    tapServer.state.faults.push({ method: "POST", path: CREATE_PATH, fault: { delayMs: 17_000 } });
    const run = await tap(["approve", CAMPAIGN_ID, "--all", "--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome: "create_unknown", status: "unknown", reason: "TAP took too long to answer", may_exist: true });
    await until(() => tapServer.state.approvals.size === 1, "the slow create landed");
  }, 40_000);

  it("stops watching on Ctrl+C under status --wait, without withdrawing", async () => {
    const created = await tap(["approve", CAMPAIGN_ID, "--all", "--no-wait", "--json"]);
    const { id } = JSON.parse(created.stdout);
    mark = tapServer.requests.length;
    const run = await tap(["approve", "status", id, "--wait"], { onSpawn: (child) => void until(longPolling, "status is waiting").then(() => child.kill("SIGINT")) });
    expect(run.code).toBe(130);
    expect(run.output).toContain("You stopped watching. The request was not withdrawn.");
    expectLeftOpenText(run.output, id);
    expect(cancels(run.calls)).toHaveLength(0);
    expect(onlyApproval().status).toBe("pending");
  }, T);

  it("says a request TAP does not have is gone", async () => {
    const run = await tap(["approve", "status", "00000000-0000-4000-8000-000000000000", "--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome: "gone", status: "gone" });
  }, T);
});
