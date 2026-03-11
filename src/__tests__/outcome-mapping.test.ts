import { describe, it, expect } from "vitest";
import {
  mapOutcomeToStatuses,
  VALID_OUTCOME_TYPES,
  type OutcomeType,
} from "../lib/outcome-mapping.js";

describe("mapOutcomeToStatuses", () => {
  it("maps pitched to sent + contacted", () => {
    expect(mapOutcomeToStatuses("pitched")).toEqual({
      pitchStatus: "sent",
      pipelineStatus: "contacted",
    });
  });

  it("maps opened to opened + contacted", () => {
    expect(mapOutcomeToStatuses("opened")).toEqual({
      pitchStatus: "opened",
      pipelineStatus: "contacted",
    });
  });

  it("maps replied to replied + responded", () => {
    expect(mapOutcomeToStatuses("replied")).toEqual({
      pitchStatus: "replied",
      pipelineStatus: "responded",
    });
  });

  it("maps interested to replied + responded", () => {
    expect(mapOutcomeToStatuses("interested")).toEqual({
      pitchStatus: "replied",
      pipelineStatus: "responded",
    });
  });

  it("maps played to converted (no pitch status change)", () => {
    const result = mapOutcomeToStatuses("played");
    expect(result.pipelineStatus).toBe("converted");
    expect(result.pitchStatus).toBeUndefined();
  });

  it("maps covered to converted", () => {
    expect(mapOutcomeToStatuses("covered")).toEqual({
      pipelineStatus: "converted",
    });
  });

  it("maps added to converted", () => {
    expect(mapOutcomeToStatuses("added")).toEqual({
      pipelineStatus: "converted",
    });
  });

  it("maps declined to declined + contacted", () => {
    expect(mapOutcomeToStatuses("declined")).toEqual({
      pitchStatus: "declined",
      pipelineStatus: "contacted",
    });
  });

  it("maps passed to declined + contacted", () => {
    expect(mapOutcomeToStatuses("passed")).toEqual({
      pitchStatus: "declined",
      pipelineStatus: "contacted",
    });
  });

  it("maps bounced to bounced (no pipeline change)", () => {
    const result = mapOutcomeToStatuses("bounced");
    expect(result.pitchStatus).toBe("bounced");
    expect(result.pipelineStatus).toBeUndefined();
  });

  it("maps no_response to empty (no changes)", () => {
    expect(mapOutcomeToStatuses("no_response")).toEqual({});
  });

  it("maps called to empty (no changes)", () => {
    expect(mapOutcomeToStatuses("called")).toEqual({});
  });

  it("maps follow_up_scheduled to empty (no changes)", () => {
    expect(mapOutcomeToStatuses("follow_up_scheduled")).toEqual({});
  });

  it("covers all valid outcome types", () => {
    // Every type should return an object (even if empty)
    for (const type of VALID_OUTCOME_TYPES) {
      const result = mapOutcomeToStatuses(type);
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    }
  });

  it("exports exactly 13 outcome types", () => {
    expect(VALID_OUTCOME_TYPES).toHaveLength(13);
  });

  it("includes all expected types", () => {
    const expected: OutcomeType[] = [
      "pitched",
      "opened",
      "replied",
      "interested",
      "played",
      "covered",
      "added",
      "declined",
      "passed",
      "bounced",
      "no_response",
      "called",
      "follow_up_scheduled",
    ];
    expect(VALID_OUTCOME_TYPES).toEqual(expect.arrayContaining(expected));
  });
});
