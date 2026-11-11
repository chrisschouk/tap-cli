import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startFakeTap } from "./fake-tap.js";

let tapServer: Awaited<ReturnType<typeof startFakeTap>>;

beforeAll(async () => {
  tapServer = await startFakeTap();
  process.env.TAP_URL = tapServer.url;
  process.env.TAP_API_KEY = "tap_ak_test";
});
afterAll(() => tapServer.close());

describe("runCommand in interactive mode", () => {
  it("returns to the caller when a command fails with process.exit(1)", async () => {
    const realExit = process.exit;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runCommand } = await import("../ui/run-command.js");

    await expect(runCommand(["campaigns", "show", "missing-id"])).resolves.toBeUndefined();

    expect(process.exit).toBe(realExit);
    expect(errors.mock.calls.flat().join(" ")).toContain("Campaign not found");
    vi.restoreAllMocks();
  }, 20_000);
});
