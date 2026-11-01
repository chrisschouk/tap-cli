import { describe, it, expect } from "vitest";
import { checkApiKeyFormat, maskApiKey } from "../lib/key-validation.js";

// ---------------------------------------------------------------------------
// checkApiKeyFormat
// ---------------------------------------------------------------------------

describe("checkApiKeyFormat", () => {
  it("rejects empty/undefined/null", () => {
    expect(checkApiKeyFormat("").valid).toBe(false);
    expect(checkApiKeyFormat(undefined).valid).toBe(false);
    expect(checkApiKeyFormat(null).valid).toBe(false);
  });

  it("rejects a key with the wrong prefix", () => {
    const result = checkApiKeyFormat("sk_live_" + "x".repeat(40));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/tap_ak_/);
  });

  it("rejects a key that's too short", () => {
    const result = checkApiKeyFormat("tap_ak_short");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/short/i);
  });

  it("accepts a well-formed key", () => {
    const key = "tap_ak_live_" + "a".repeat(32);
    expect(checkApiKeyFormat(key)).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// maskApiKey
// ---------------------------------------------------------------------------

describe("maskApiKey", () => {
  it("returns empty string for empty input", () => {
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey(undefined)).toBe("");
    expect(maskApiKey(null)).toBe("");
  });

  it("masks the middle of a well-formed key, keeping the prefix and last 4 chars", () => {
    const key = "tap_ak_live_abcdef1234";
    const masked = maskApiKey(key);
    expect(masked.startsWith("tap_ak_")).toBe(true);
    expect(masked.endsWith("1234")).toBe(true);
    expect(masked).not.toContain("abcdef");
  });

  it("never returns the full key unmasked", () => {
    const key = "tap_ak_live_" + "a".repeat(32);
    expect(maskApiKey(key)).not.toBe(key);
  });
});
