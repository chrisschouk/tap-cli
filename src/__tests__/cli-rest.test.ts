import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeTap, CAMPAIGN_ID, NO_PLAN_KEY } from "./fake-tap.js";
import { freshHome, runTap, type RunOptions } from "./tap-process.js";

let tapServer: Awaited<ReturnType<typeof startFakeTap>>;

beforeAll(async () => {
  tapServer = await startFakeTap();
});
beforeEach(() => tapServer.reset());
afterAll(() => tapServer.close());

function tap(args: string[], opts: RunOptions = {}) {
  return runTap(tapServer, args, opts);
}

const T = 20_000;

describe("campaigns and contacts", () => {
  it("lists campaigns with the API key as a bearer token", async () => {
    const { code, output, calls } = await tap(["campaigns", "list"]);
    expect(code).toBe(0);
    expect(output).toContain("Night Drive");
    expect(output).toContain("sadact");
    expect(calls).toEqual([expect.objectContaining({ method: "GET", path: "/api/v1/campaigns", auth: "Bearer tap_ak_test", query: {} })]);
  }, T);

  it("shows a campaign and hints with full IDs that resolve", async () => {
    const { code, output, calls } = await tap(["campaigns", "show", CAMPAIGN_ID]);
    expect(code).toBe(0);
    expect(output).toContain("Daytime radio");
    expect(output).toContain(`tap send ${CAMPAIGN_ID}`);
    expect(calls.map((c) => [c.path, c.query])).toEqual([
      [`/api/v1/campaigns/${CAMPAIGN_ID}`, {}],
      [`/api/v1/campaigns/${CAMPAIGN_ID}/contacts`, { limit: "100" }],
      ["/api/v1/outcomes", { campaign_id: CAMPAIGN_ID, limit: "100" }],
    ]);
  }, T);

  it("lists a page of contacts with the server's own fields and says how many there are", async () => {
    const { code, output, calls } = await tap(["contacts", "list", "--platform", "radio", "-l", "20", "--page", "2"]);
    expect(code).toBe(0);
    expect(calls[0].query).toEqual({ limit: "20", page: "2", platform_type: "radio" });
    expect(output).toContain("21–40 of 115 contacts");
    expect(output).toContain("--page 3 for more");
  }, T);

  it("rejects the filters GET /contacts cannot answer", async () => {
    const { code, calls } = await tap(["contacts", "list", "--warm"]);
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
  }, T);

  it("reports unlimited enrichments when TAP returns no credit count", async () => {
    const id = tapServer.state.contacts[0].id;
    const { code, output } = await tap(["contacts", "enrich", id]);
    expect(code).toBe(0);
    expect(output).toContain("Unlimited enrichments on your plan");
  }, T);
});

describe("pitch", () => {
  it("passes the chosen tone", async () => {
    const { code, output, calls } = await tap(["pitch", CAMPAIGN_ID, "k1", "--tone", "casual"]);
    expect(code).toBe(0);
    expect(output).toContain("New single for you (casual).");
    expect(output).toContain(`tap send ${CAMPAIGN_ID}`);
    expect(calls.map((c) => c.body)).toEqual([{ contact_ids: ["k1"], tone: "casual" }]);
  }, T);

  it("sends no tone by default, so TAP varies it across variants", async () => {
    const { code, output, calls } = await tap(["pitch", CAMPAIGN_ID, "k1"]);
    expect(code).toBe(0);
    expect(calls.map((c) => c.body)).toEqual([{ contact_ids: ["k1"] }]);
    expect(output).toContain("(enthusiastic)");
  }, T);
});

describe("send never sends", () => {
  it("finds waiting pitches behind more than 200 sent ones and links to TAP", async () => {
    const { code, output, calls } = await tap(["send", CAMPAIGN_ID]);
    expect(code).toBe(0);
    expect(output).toContain("Night Drive for your Friday show");
    expect(output).toContain("waiting for approval");
    expect(output).toContain("approved, not sent yet");
    expect(output).toContain("approved, send failed");
    expect(output).toContain("approved, held for payment");
    expect(output).toContain("Still a draft");
    expect(output).not.toContain("Sent pitch");
    expect(output).toContain(`${tapServer.url}/releases/${CAMPAIGN_ID}?tab=pitching`);
    expect(output).not.toContain("#waiting-on-you");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    const queueQueries = calls.filter((c) => c.path === "/api/v1/outreach/queue").map((c) => c.query.state);
    expect(queueQueries.sort()).toEqual(["approved", "draft", "pending_approval"]);
  }, T);

  it("gives every waiting pitch as JSON", async () => {
    const { code, stdout } = await tap(["send", CAMPAIGN_ID, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.approve_url).toBe(`${tapServer.url}/releases/${CAMPAIGN_ID}?tab=pitching`);
    expect(parsed.pitches.map((p: { state: string }) => p.state).sort()).toEqual([
      "approved",
      "draft",
      "held_for_payment",
      "pending_approval",
      "pending_approval",
      "pending_approval",
      "send_failed",
    ]);
  }, T);
});

describe("import", () => {
  const fixture = (name: string) => join(process.cwd(), "src/__tests__/fixtures", name);

  it("imports sink output from a file and links every contact, new or existing, to the campaign", async () => {
    const { code, output, calls } = await tap(["import", fixture("sink-wash-envelope.json"), "--yes", "--campaign", CAMPAIGN_ID]);
    expect(code).toBe(0);
    expect(output).toContain("TAP does not store phone, website, shows");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/contacts");
    expect((post?.body as { contacts: Array<{ email: string }> }).contacts.map((c) => c.email)).toEqual([
      "jo@bbc.co.uk",
      "sam@gmail.com",
      "ali@amazingradio.com",
    ]);
    expect(output).toContain("2 imported");
    expect(output).toContain("1 already in TAP");
    const link = calls.find((c) => c.path === `/api/v1/campaigns/${CAMPAIGN_ID}/contacts`);
    expect((link?.body as { contact_ids: string[] }).contact_ids).toHaveLength(3);
    expect(output).toContain("3 added to the campaign");
  }, T);

  it("reads sink's output piped on stdin", async () => {
    const stdin = readFileSync(fixture("sink-scrub.jsonl"), "utf-8");
    const { code, output, calls } = await tap(["import", "-", "--yes"], { stdin });
    expect(code).toBe(0);
    expect(output).toContain("from stdin (sink JSONL)");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  }, T);

  it("asks for --yes rather than prompting on a piped stdin", async () => {
    const { code, output, calls } = await tap(["import", "-"], { stdin: "email\na@b.com\n" });
    expect(code).toBe(1);
    expect(output).toContain("Add --yes when piping");
    expect(calls).toHaveLength(0);
  }, T);

  it("sends at most 500 contacts per request and 200 ids per link", async () => {
    const csv = ["email", ...Array.from({ length: 1201 }, (_, i) => `new${i}@example.com`)].join("\n");
    const { code, output, calls } = await tap(["import", "-", "--yes", "--campaign", CAMPAIGN_ID], { stdin: csv });
    expect(code).toBe(0);
    const sizes = calls.filter((c) => c.method === "POST" && c.path === "/api/v1/contacts").map((c) => (c.body as { contacts: unknown[] }).contacts.length);
    expect(sizes).toEqual([500, 500, 201]);
    const links = calls.filter((c) => c.method === "POST" && c.path.endsWith("/contacts") && c.path !== "/api/v1/contacts");
    expect(links.map((c) => (c.body as { contact_ids: unknown[] }).contact_ids.length)).toEqual([200, 200, 200, 200, 200, 200, 1]);
    expect(output).toContain("1201 imported");
  }, T);
});

describe("errors and config", () => {
  it("shows TAP's year-plan message from a real route", async () => {
    const { code, output } = await tap(["campaigns", "list"], { env: { TAP_API_KEY: NO_PLAN_KEY } });
    expect(code).toBe(1);
    expect(output).toContain("This API key needs the £129 year plan.");
  }, T);

  it("open stops on a plan refusal instead of reporting the record missing", async () => {
    const { code, output } = await tap(["open", CAMPAIGN_ID, "--url"], { env: { TAP_API_KEY: NO_PLAN_KEY } });
    expect(code).toBe(1);
    expect(output).toContain("year plan");
    expect(output).not.toContain("No contact or campaign found");
  }, T);

  it("open falls through to the campaign when no contact has the ID", async () => {
    const { code, stdout } = await tap(["open", CAMPAIGN_ID, "--url"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`${tapServer.url}/releases/${CAMPAIGN_ID}`);
  }, T);

  it("refuses to run on legacy Supabase credentials alone, and says to delete and rotate them", async () => {
    const home = freshHome({ supabaseUrl: "https://legacy.supabase.co", supabaseKey: "service-role-key-123456" });
    const { code, output, calls } = await tap(["campaigns", "list"], { env: { HOME: home, TAP_API_KEY: undefined } });
    expect(code).toBe(1);
    expect(output).toContain("No TAP API key configured");
    expect(output.match(/no longer uses them/g)).toHaveLength(1);
    expect(output).toContain("rotate");
    expect(calls).toHaveLength(0);
  }, T);

  it("auth status says the key comes from TAP_API_KEY and that it overrides the saved one", async () => {
    const home = freshHome({ apiKey: "tap_ak_saved_in_file" });
    const { code, output } = await tap(["auth", "status"], { env: { HOME: home } });
    expect(code).toBe(0);
    expect(output).toContain("(from TAP_API_KEY)");
    expect(output).toContain("TAP_API_KEY overrides the key saved");
  }, T);

  it("points commands without an API endpoint at the TAP page and calls nothing", async () => {
    const stats = await tap(["stats"]);
    expect(stats.code).toBe(0);
    expect(stats.output).toContain(`${tapServer.url}/home`);
    expect(stats.calls).toHaveLength(0);

    const watch = await tap(["watch", CAMPAIGN_ID]);
    expect(watch.output).toContain(`${tapServer.url}/releases/${CAMPAIGN_ID}?tab=report`);
    expect(watch.calls).toHaveLength(0);
  }, T);
});
