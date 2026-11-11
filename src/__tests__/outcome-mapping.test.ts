import { describe, it, expect } from "vitest";
import { parseOutcomeType, VALID_OUTCOME_TYPES } from "../lib/outcome-mapping.js";

describe("parseOutcomeType", () => {
  it("accepts every type the TAP outcomes endpoint accepts", () => {
    for (const type of VALID_OUTCOME_TYPES) {
      expect(parseOutcomeType(type)).toBe(type);
    }
  });

  it("maps older CLI words to the TAP vocabulary", () => {
    expect(parseOutcomeType("replied")).toBe("replied_positive");
    expect(parseOutcomeType("interested")).toBe("replied_positive");
    expect(parseOutcomeType("played")).toBe("coverage");
    expect(parseOutcomeType("covered")).toBe("coverage");
    expect(parseOutcomeType("added")).toBe("added_to_playlist");
    expect(parseOutcomeType("passed")).toBe("declined");
  });

  it("ignores case and surrounding space", () => {
    expect(parseOutcomeType("  Declined ")).toBe("declined");
  });

  it("rejects words TAP cannot record", () => {
    expect(parseOutcomeType("pitched")).toBeNull();
    expect(parseOutcomeType("bounced")).toBeNull();
    expect(parseOutcomeType("")).toBeNull();
  });
});
