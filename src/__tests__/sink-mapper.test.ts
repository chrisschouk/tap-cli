import { describe, it, expect } from "vitest";
import {
  detectSinkFormat,
  filterImportable,
  mapSinkRecordToContact,
  type SinkRecord,
} from "../lib/sink-mapper.js";

// ---------------------------------------------------------------------------
// detectSinkFormat
// ---------------------------------------------------------------------------

describe("detectSinkFormat", () => {
  it("detects envelope format (stats + records wrapper)", () => {
    const data = { stats: { total: 1 }, records: [{ raw: { email: "a@b.com" } }] };
    expect(detectSinkFormat(data)).toBe("envelope");
  });

  it("detects array format (SinkRecord[])", () => {
    const data = [{ raw: { email: "a@b.com" } }];
    expect(detectSinkFormat(data)).toBe("array");
  });

  it("returns unknown for plain CSV-style array (no raw key)", () => {
    const data = [{ email: "a@b.com", name: "Test" }];
    expect(detectSinkFormat(data)).toBe("unknown");
  });

  it("returns unknown for an empty array", () => {
    expect(detectSinkFormat([])).toBe("unknown");
  });

  it("returns unknown for a plain object without records key", () => {
    expect(detectSinkFormat({ email: "a@b.com" })).toBe("unknown");
  });

  it("returns unknown for null", () => {
    expect(detectSinkFormat(null)).toBe("unknown");
  });

  it("returns unknown for a string", () => {
    expect(detectSinkFormat("email,name")).toBe("unknown");
  });

  it("returns envelope when records array is empty", () => {
    // Records key exists and is an array — still envelope format
    const data = { records: [] };
    expect(detectSinkFormat(data)).toBe("envelope");
  });
});

// ---------------------------------------------------------------------------
// filterImportable
// ---------------------------------------------------------------------------

describe("filterImportable", () => {
  const validRecord: SinkRecord = {
    raw: { email: "valid@example.com", name: "Alice" },
    scrub: { email: { normalised: "valid@example.com", valid: true } },
  };

  const duplicateRecord: SinkRecord = {
    raw: { email: "dup@example.com" },
    rinse: { duplicate: true },
  };

  const invalidEmailRecord: SinkRecord = {
    raw: { email: "not-an-email" },
    scrub: { email: { valid: false } },
  };

  it("passes valid records through", () => {
    const result = filterImportable([validRecord]);
    expect(result.valid).toHaveLength(1);
    expect(result.skippedDuplicate).toBe(0);
    expect(result.skippedInvalid).toBe(0);
  });

  it("skips duplicate records and counts them", () => {
    const result = filterImportable([validRecord, duplicateRecord]);
    expect(result.valid).toHaveLength(1);
    expect(result.skippedDuplicate).toBe(1);
  });

  it("skips records with invalid email and counts them", () => {
    const result = filterImportable([validRecord, invalidEmailRecord]);
    expect(result.valid).toHaveLength(1);
    expect(result.skippedInvalid).toBe(1);
  });

  it("handles a mix of valid, duplicate, and invalid", () => {
    const result = filterImportable([validRecord, duplicateRecord, invalidEmailRecord]);
    expect(result.valid).toHaveLength(1);
    expect(result.skippedDuplicate).toBe(1);
    expect(result.skippedInvalid).toBe(1);
  });

  it("handles an empty array", () => {
    const result = filterImportable([]);
    expect(result.valid).toHaveLength(0);
    expect(result.skippedDuplicate).toBe(0);
    expect(result.skippedInvalid).toBe(0);
  });

  it("does not skip a record where rinse.duplicate is false", () => {
    const record: SinkRecord = { raw: { email: "ok@example.com" }, rinse: { duplicate: false } };
    const result = filterImportable([record]);
    expect(result.valid).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mapSinkRecordToContact
// ---------------------------------------------------------------------------

describe("mapSinkRecordToContact", () => {
  it("returns null when there is no email at all", () => {
    const record: SinkRecord = { raw: { name: "No Email" } };
    expect(mapSinkRecordToContact(record)).toBeNull();
  });

  it("maps basic fields from raw", () => {
    const record: SinkRecord = {
      raw: { name: "Bob Smith", email: "bob@radio.com", outlet: "Radio X", role: "Music Director" },
    };
    const result = mapSinkRecordToContact(record);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Bob Smith");
    expect(result!.email).toBe("bob@radio.com");
    expect(result!.outlet).toBe("Radio X");
    expect(result!.role).toBe("Music Director");
  });

  it("prefers scrub normalised email over raw email", () => {
    const record: SinkRecord = {
      raw: { email: "BOB@RADIO.COM" },
      scrub: { email: { normalised: "bob@radio.com", valid: true } },
    };
    const result = mapSinkRecordToContact(record);
    expect(result!.email).toBe("bob@radio.com");
  });

  it("lowercases and trims the email", () => {
    const record: SinkRecord = { raw: { email: "  BOB@RADIO.COM  " } };
    const result = mapSinkRecordToContact(record);
    expect(result!.email).toBe("bob@radio.com");
  });

  it("maps soak enrichment fields", () => {
    const record: SinkRecord = {
      raw: { email: "dj@station.com" },
      soak: {
        platformType: "Radio",
        genres: ["house", "techno"],
        coverageArea: "UK",
        coverageAreas: ["UK", "EU"],
        geographicScope: "National",
        bestTiming: "Monday mornings",
        submissionGuidelines: "Send MP3 + one-pager",
        pitchTips: ["Keep it short", "Mention chart position"],
        confidence: "High",
        contactMethod: "email",
      },
    };
    const result = mapSinkRecordToContact(record);
    expect(result!.platform_type).toBe("Radio");
    expect(result!.genres).toEqual(["house", "techno"]);
    expect(result!.coverage_area).toBe("UK");
    expect(result!.coverage_areas).toEqual(["UK", "EU"]);
    expect(result!.geographic_scope).toBe("National");
    expect(result!.best_timing).toBe("Monday mornings");
    expect(result!.submission_guidelines).toBe("Send MP3 + one-pager");
    expect(result!.pitch_tips).toEqual(["Keep it short", "Mention chart position"]);
    expect(result!.enrichment_confidence).toBe("High");
    expect(result!.contact_method).toBe("email");
  });

  it("sets enriched = true and enrichment_source = sink when soak data present", () => {
    const record: SinkRecord = {
      raw: { email: "dj@station.com" },
      soak: { platformType: "Radio" },
    };
    const result = mapSinkRecordToContact(record);
    expect(result!.enriched).toBe(true);
    expect(result!.enrichment_source).toBe("sink");
    expect(result!.enriched_at).not.toBeNull();
  });

  it("sets enriched = false and enrichment_source = null when no soak data", () => {
    const record: SinkRecord = { raw: { email: "plain@example.com" } };
    const result = mapSinkRecordToContact(record);
    expect(result!.enriched).toBe(false);
    expect(result!.enrichment_source).toBeNull();
    expect(result!.enriched_at).toBeNull();
  });

  it("sets null for missing optional raw fields", () => {
    const record: SinkRecord = { raw: { email: "bare@example.com" } };
    const result = mapSinkRecordToContact(record);
    expect(result!.name).toBeNull();
    expect(result!.outlet).toBeNull();
    expect(result!.role).toBeNull();
  });
});
