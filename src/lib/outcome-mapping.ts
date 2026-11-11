/**
 * Outcome types accepted by `POST /api/v1/outcomes`. TAP updates pitch and
 * contact status itself when an outcome is logged.
 *
 * Older CLI words still work as aliases so existing scripts keep running.
 */

export const VALID_OUTCOME_TYPES = [
  "no_response",
  "opened",
  "replied_positive",
  "replied_negative",
  "added_to_playlist",
  "interview_booked",
  "coverage",
  "declined",
  "other",
] as const;

export type OutcomeType = (typeof VALID_OUTCOME_TYPES)[number];

const ALIASES: Record<string, OutcomeType> = {
  replied: "replied_positive",
  interested: "replied_positive",
  played: "coverage",
  covered: "coverage",
  added: "added_to_playlist",
  passed: "declined",
};

export function parseOutcomeType(input: string): OutcomeType | null {
  const key = input.trim().toLowerCase();
  if ((VALID_OUTCOME_TYPES as readonly string[]).includes(key)) return key as OutcomeType;
  return ALIASES[key] ?? null;
}
