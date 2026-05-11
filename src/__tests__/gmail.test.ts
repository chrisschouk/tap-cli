import { describe, it, expect } from "vitest";
import { buildRawMessage } from "../lib/gmail.js";

// ---------------------------------------------------------------------------
// buildRawMessage
// ---------------------------------------------------------------------------

describe("buildRawMessage", () => {
  /**
   * Decode a base64url string back to the raw MIME message for inspection.
   */
  function decodeRawMessage(encoded: string): string {
    // Restore base64 padding and convert back from base64url
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64").toString("utf-8");
  }

  it("returns a non-empty base64url-encoded string", () => {
    const result = buildRawMessage("to@example.com", "Hello", "Body text");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes To header in the decoded message", () => {
    const result = buildRawMessage("recipient@example.com", "Subject", "Body");
    const decoded = decodeRawMessage(result);
    expect(decoded).toContain("To: recipient@example.com");
  });

  it("includes Subject header in the decoded message", () => {
    const result = buildRawMessage("to@example.com", "My Subject", "Body");
    const decoded = decodeRawMessage(result);
    expect(decoded).toContain("Subject: My Subject");
  });

  it("includes the body in the decoded message", () => {
    const result = buildRawMessage("to@example.com", "Subject", "Hello, this is the body.");
    const decoded = decodeRawMessage(result);
    expect(decoded).toContain("Hello, this is the body.");
  });

  it("defaults From to 'me' when no from address is supplied", () => {
    const result = buildRawMessage("to@example.com", "Subject", "Body");
    const decoded = decodeRawMessage(result);
    expect(decoded).toContain("From: me");
  });

  it("uses the provided from address", () => {
    const result = buildRawMessage("to@example.com", "Subject", "Body", "sender@myagency.com");
    const decoded = decodeRawMessage(result);
    expect(decoded).toContain("From: sender@myagency.com");
  });

  it("includes required MIME headers", () => {
    const result = buildRawMessage("to@example.com", "Subject", "Body");
    const decoded = decodeRawMessage(result);
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toContain("Content-Type: text/plain; charset=utf-8");
  });

  it("separates headers from body with a blank line (CRLF+CRLF)", () => {
    const result = buildRawMessage("to@example.com", "Subject", "Body content here");
    const decoded = decodeRawMessage(result);
    // RFC 2822 requires \r\n\r\n between headers and body
    expect(decoded).toContain("\r\n\r\n");
    const [, body] = decoded.split("\r\n\r\n");
    expect(body).toBe("Body content here");
  });

  it("handles special characters in the subject without breaking encoding", () => {
    const subject = "Re: [New Music] The Remedy — 'Drift' (BBC 6 Music)";
    const result = buildRawMessage("to@example.com", subject, "Body");
    const decoded = decodeRawMessage(result);
    expect(decoded).toContain(`Subject: ${subject}`);
  });

  it("produces valid base64url output (no +, /, or trailing =)", () => {
    const result = buildRawMessage("to@example.com", "Test", "Body text here.");
    expect(result).not.toMatch(/\+/);
    expect(result).not.toMatch(/\//);
    expect(result).not.toMatch(/=+$/);
  });

  it("correctly round-trips a multi-line body", () => {
    const body = "Line one.\r\nLine two.\r\nLine three.";
    const result = buildRawMessage("to@example.com", "Subject", body);
    const decoded = decodeRawMessage(result);
    expect(decoded).toContain(body);
  });
});
