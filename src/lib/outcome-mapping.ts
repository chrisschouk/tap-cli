/**
 * Maps outcome types to pitch_status and pipeline_status updates.
 *
 * Pure function -- no side effects, no DB calls. Easy to test.
 */

export type OutcomeType =
  | "pitched"
  | "opened"
  | "replied"
  | "interested"
  | "played"
  | "covered"
  | "added"
  | "declined"
  | "passed"
  | "bounced"
  | "no_response"
  | "called"
  | "follow_up_scheduled";

export interface StatusUpdate {
  pitchStatus?: string;
  pipelineStatus?: string;
}

const OUTCOME_MAP: Record<OutcomeType, StatusUpdate> = {
  // Outreach stages
  pitched: { pitchStatus: "sent", pipelineStatus: "contacted" },
  opened: { pitchStatus: "opened", pipelineStatus: "contacted" },

  // Engagement stages
  replied: { pitchStatus: "replied", pipelineStatus: "responded" },
  interested: { pitchStatus: "replied", pipelineStatus: "responded" },

  // Conversion stages
  played: { pipelineStatus: "converted" },
  covered: { pipelineStatus: "converted" },
  added: { pipelineStatus: "converted" },

  // Negative outcomes
  declined: { pitchStatus: "declined", pipelineStatus: "contacted" },
  passed: { pitchStatus: "declined", pipelineStatus: "contacted" },
  bounced: { pitchStatus: "bounced" },

  // Neutral -- no status change
  no_response: {},
  called: {},
  follow_up_scheduled: {},
};

export const VALID_OUTCOME_TYPES = Object.keys(OUTCOME_MAP) as OutcomeType[];

export function mapOutcomeToStatuses(type: OutcomeType): StatusUpdate {
  return OUTCOME_MAP[type] ?? {};
}
