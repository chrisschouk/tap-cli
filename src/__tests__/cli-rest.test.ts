import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const CAMPAIGN = { id: "c1", name: "Night Drive", artist_name: "sadact", status: "active" };

const ROUTES: Record<string, (body: unknown) => [number, unknown]> = {
  "GET /api/v1/campaigns": () => [200, { campaigns: [{ ...CAMPAIGN, release_date: "2026-12-01" }], total: 1 }],
  "GET /api/v1/campaigns/c1": () => [200, { campaign: CAMPAIGN, stats: {} }],
  "GET /api/v1/campaigns/c1/pitches": () => [
    200,
    {
      pitches: [
        { id: "p1", title: null, subject: "Night Drive for your Friday show", send_status: "draft" },
        { id: "p2", title: null, subject: "Approved already", send_status: "draft" },
        { id: "p3", title: null, subject: "Went out last week", send_status: "sent" },
      ],
    },
  ],
  "GET /api/v1/outreach/queue": () => [
    200,
    {
      items: [
        { id: "p1", state: "pending_approval", send_status: "draft", scheduled_for: null },
        { id: "p2", state: "approved", send_status: "draft", scheduled_for: "2026-11-12T09:00:00Z" },
        { id: "p3", state: "sent", send_status: "sent", scheduled_for: null },
      ],
    },
  ],
  "POST /api/v1/campaigns/c1/pitches": () => [
    201,
    {
      drafts: [
        {
          contact_id: "k1",
          contact_name: "Jo Presenter",
          variants: [{ subject: "Night Drive", body: "Hi Jo,\nNew single for you.", tone: "casual" }],
        },
      ],
    },
  ],
  "GET /api/v1/campaigns/plan": () => [
    402,
    { success: false, error: { code: "SUBSCRIPTION_REQUIRED", message: "This API key needs the £129 year plan." } },
  ],
};

interface Recorded {
  method: string;
  path: string;
  search: string;
  auth: string | undefined;
  body: unknown;
}

let server: Server;
let baseUrl: string;
const requests: Recorded[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? "", path: url.pathname, search: url.search, auth: req.headers.authorization, body });
      const handler = ROUTES[`${req.method} ${url.pathname}`];
      const [status, payload] = handler ? handler(body) : [404, { error: "Not found" }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

function freshHome(config?: object): string {
  const home = mkdtempSync(join(tmpdir(), "tap-cli-"));
  if (config) {
    mkdirSync(join(home, ".tap"));
    writeFileSync(join(home, ".tap", "config.json"), JSON.stringify(config));
  }
  return home;
}

function tap(args: string[], env: Record<string, string | undefined> = {}) {
  const before = requests.length;
  return new Promise<{ code: number; stdout: string; output: string; calls: Recorded[] }>((resolve) => {
    execFile(
      join(process.cwd(), "node_modules/.bin/tsx"),
      ["src/cli.ts", ...args],
      {
        env: {
          PATH: process.env.PATH,
          HOME: freshHome(),
          NO_COLOR: "1",
          TAP_API_KEY: "tap_ak_test",
          TAP_URL: baseUrl,
          SUPABASE_URL: "https://legacy.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-should-be-ignored",
          ...env,
        },
      },
      (err, stdout, stderr) =>
        resolve({
          code: err ? Number((err as { code?: number }).code ?? 1) : 0,
          stdout,
          output: stdout + stderr,
          calls: requests.slice(before),
        }),
    );
  });
}

describe("tap CLI over REST v1", () => {
  it("lists campaigns with the API key as a bearer token", async () => {
    const { code, output, calls } = await tap(["campaigns", "list"]);
    expect(code).toBe(0);
    expect(output).toContain("Night Drive");
    expect(output).toContain("sadact");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/campaigns", auth: "Bearer tap_ak_test" });
  }, 20_000);

  it("asks TAP to draft a pitch with the chosen tone and shows the variants", async () => {
    const { code, output, calls } = await tap(["pitch", "c1", "k1", "--tone", "casual"]);
    expect(code).toBe(0);
    expect(output).toContain("Jo Presenter");
    expect(output).toContain("New single for you.");
    expect(output).toContain("tap send c1");
    expect(calls).toEqual([
      expect.objectContaining({ method: "POST", path: "/api/v1/campaigns/c1/pitches", body: { contact_ids: ["k1"], tone: "casual" } }),
    ]);
  }, 20_000);

  it("lists pitches waiting for the artist and links to approve and send, without writing anything", async () => {
    const { code, output, calls } = await tap(["send", "c1"]);
    expect(code).toBe(0);
    expect(output).toContain("Night Drive for your Friday show");
    expect(output).toContain("waiting for approval");
    expect(output).toContain("Approved already");
    expect(output).toContain("approved, not sent yet");
    expect(output).not.toContain("Went out last week");
    expect(output).toContain(`${baseUrl}/releases/c1?tab=pitching#waiting-on-you`);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  }, 20_000);

  it("gives the waiting pitches and the approve link as JSON", async () => {
    const { code, stdout } = await tap(["send", "c1", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.approve_url).toBe(`${baseUrl}/releases/c1?tab=pitching#waiting-on-you`);
    expect(parsed.pitches.map((p: { id: string; state: string }) => [p.id, p.state])).toEqual([
      ["p1", "pending_approval"],
      ["p2", "approved"],
    ]);
  }, 20_000);

  it("points commands without an API endpoint at the TAP page and calls nothing", async () => {
    const stats = await tap(["stats"]);
    expect(stats.code).toBe(0);
    expect(stats.output).toContain(`${baseUrl}/home`);
    expect(stats.calls).toHaveLength(0);

    const watch = await tap(["watch", "c1", "--interval", "10"]);
    expect(watch.output).toContain(`${baseUrl}/releases/c1?tab=activity`);
    expect(watch.calls).toHaveLength(0);
  }, 20_000);

  it("shows the year-plan message from TAP's plan guard", async () => {
    const { code, output } = await tap(["send", "plan"]);
    expect(code).toBe(1);
    expect(output).toContain("This API key needs the £129 year plan.");
  }, 20_000);

  it("refuses to run on legacy Supabase credentials alone", async () => {
    const home = freshHome({ supabaseUrl: "https://legacy.supabase.co", supabaseKey: "service-role-key-123456" });
    const { code, output, calls } = await tap(["campaigns", "list"], { HOME: home, TAP_API_KEY: undefined });
    expect(code).toBe(1);
    expect(output).toContain("No TAP API key configured");
    expect(calls).toHaveLength(0);
  }, 20_000);
});
