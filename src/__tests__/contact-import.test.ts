import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseImport, csvRows, flattenSinkRecord, mapRow } from "../lib/contact-import.js";

/** Real `datasink@0.4.1` output for fixtures/sink-input.csv (see fixtures/README). */
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf-8");

const JO = {
  email: "jo@bbc.co.uk",
  name: "Jo Presenter",
  outlet: "BBC Radio 6 Music",
  role: "presenter",
  notes: "Prefers links, not attachments",
};

describe("parseImport reads every format sink writes", () => {
  it.each([
    ["sink-wash-envelope.json", "sink JSON"],
    ["sink-wash.json", "sink JSON"],
    ["sink-scrub.jsonl", "sink JSONL"],
    ["sink-wash.csv", "CSV"],
  ])("%s", (file, format) => {
    const parsed = parseImport(fixture(file));
    expect(parsed.format).toBe(format);
    expect(parsed.contacts.map((c) => c.email)).toEqual(["jo@bbc.co.uk", "sam@gmail.com", "ali@amazingradio.com"]);
    expect(parsed.contacts[0]).toEqual(JO);
    expect(parsed.contacts[2].notes).toBe('Says "hi" to everyone');
    expect(parsed.skippedInvalid).toBe(1);
    expect(parsed.dropped).toEqual(expect.arrayContaining(["phone", "website", "shows"]));
  });

  it("uses sink's corrected email, not the typo in the source", () => {
    const parsed = parseImport(fixture("sink-wash-envelope.json"));
    expect(parsed.contacts.map((c) => c.email)).toContain("sam@gmail.com");
    expect(parsed.contacts.map((c) => c.email)).not.toContain("sam@gmial.com");
  });

  it("skips the rows sink marked as duplicates", () => {
    const parsed = parseImport(fixture("sink-wash-envelope.json"));
    expect(parsed.total).toBe(5);
    expect(parsed.skippedDuplicate).toBe(1);
  });

  it("collapses repeated emails in a plain list sink never saw", () => {
    const parsed = parseImport(fixture("sink-input.csv"));
    expect(parsed.contacts.map((c) => c.email)).toEqual(["jo@bbc.co.uk", "sam@gmial.com", "ali@amazingradio.com"]);
    expect(parsed.skippedDuplicate).toBe(1);
  });
});

describe("sink enrichment", () => {
  const record = {
    raw: { name: "Ali", email: "ali@amazingradio.com" },
    scrub: { email: { valid: true, normalised: "ali@amazingradio.com" } },
    rinse: { duplicate: false },
    soak: {
      provider: "anthropic",
      platformType: "radio",
      genres: ["electronic", "ambient"],
      geographicScope: "national",
      bestTiming: "Mornings",
      pitchTips: ["Keep it short"],
      confidence: "high",
    },
    steep: { provider: "anthropic", outletDomain: "amazingradio.com" },
  };

  it("keeps the fields TAP stores and names the ones it drops", () => {
    const mapped = mapRow(flattenSinkRecord(record));
    expect(mapped).toEqual({
      kind: "contact",
      contact: { email: "ali@amazingradio.com", name: "Ali", platform_type: "radio", genres: ["electronic", "ambient"], geographic_scope: "national" },
      dropped: expect.arrayContaining(["soak besttiming", "soak pitchtips", "soak confidence", "steep (socials, portals)"]),
    });
  });

  it("rejects a row sink found invalid", () => {
    expect(mapRow(flattenSinkRecord({ ...record, scrub: { email: { valid: false, normalised: "x@y" } } }))).toEqual({ kind: "invalid" });
  });
});

describe("plain lists", () => {
  it("maps common header spellings and splits genres", () => {
    const parsed = parseImport("Full Name,E-mail,Station,Genre\nJo,JO@Example.com ,Radio X,indie; rock\n");
    expect(parsed.contacts).toEqual([{ email: "jo@example.com", name: "Jo", outlet: "Radio X", genres: ["indie", "rock"] }]);
  });

  it("reads a JSON array of contacts", () => {
    const parsed = parseImport(JSON.stringify([{ email: "a@b.com", name: "A", twitter: "@a" }, { name: "no email" }]));
    expect(parsed.format).toBe("JSON");
    expect(parsed.contacts).toEqual([{ email: "a@b.com", name: "A" }]);
    expect(parsed.skippedInvalid).toBe(1);
    expect(parsed.dropped).toEqual(["twitter"]);
  });
});

describe("csvRows", () => {
  it("handles quoted commas, doubled quotes, newlines inside quotes and CRLF", () => {
    expect(csvRows('a,b\r\n"x, y","say ""hi""\nthere"\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });

  it("keeps a final row with no trailing newline and empty trailing cells", () => {
    expect(csvRows("a,b,c\n1,,")).toEqual([["a", "b", "c"], ["1", "", ""]]);
  });
});
