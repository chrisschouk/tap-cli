/**
 * Maps sink-cli SinkRecord format to TAP contacts.
 *
 * sink-cli outputs records with { raw, scrub, soak, rinse } stages.
 * This mapper extracts the relevant fields for TAP import.
 */

export interface SinkRecord {
  raw: {
    name?: string;
    email?: string;
    outlet?: string;
    role?: string;
  };
  scrub?: {
    email?: {
      normalised?: string;
      valid?: boolean;
    };
  };
  soak?: {
    platformType?: string;
    genres?: string[];
    coverageArea?: string;
    coverageAreas?: string[];
    geographicScope?: string;
    bestTiming?: string;
    submissionGuidelines?: string;
    pitchTips?: string[];
    confidence?: string;
    contactMethod?: string;
  };
  rinse?: {
    duplicate?: boolean;
  };
}

export interface TapContactInsert {
  name: string | null;
  email: string;
  outlet: string | null;
  role: string | null;
  platform_type: string | null;
  genres: string[] | null;
  coverage_area: string | null;
  coverage_areas: string[] | null;
  geographic_scope: string | null;
  best_timing: string | null;
  submission_guidelines: string | null;
  pitch_tips: string[] | null;
  enrichment_confidence: string | null;
  contact_method: string | null;
  enriched: boolean;
  enriched_at: string | null;
  enrichment_source: string | null;
}

/**
 * Map a sink-cli SinkRecord to a TAP contact insert row.
 */
export function mapSinkRecordToContact(record: SinkRecord): TapContactInsert | null {
  const email =
    record.scrub?.email?.normalised ||
    record.raw.email;

  if (!email) return null;

  const hasSoak = record.soak && Object.keys(record.soak).length > 0;

  return {
    name: record.raw.name || null,
    email: email.toLowerCase().trim(),
    outlet: record.raw.outlet || null,
    role: record.raw.role || null,
    platform_type: record.soak?.platformType || null,
    genres: record.soak?.genres || null,
    coverage_area: record.soak?.coverageArea || null,
    coverage_areas: record.soak?.coverageAreas || null,
    geographic_scope: record.soak?.geographicScope || null,
    best_timing: record.soak?.bestTiming || null,
    submission_guidelines: record.soak?.submissionGuidelines || null,
    pitch_tips: record.soak?.pitchTips || null,
    enrichment_confidence: record.soak?.confidence || null,
    contact_method: record.soak?.contactMethod || null,
    enriched: hasSoak || false,
    enriched_at: hasSoak ? new Date().toISOString() : null,
    enrichment_source: hasSoak ? "sink" : null,
  };
}

/**
 * Filter importable records from sink output.
 * Skips duplicates flagged by rinse stage and invalid emails.
 */
export function filterImportable(
  records: SinkRecord[],
): { valid: SinkRecord[]; skippedDuplicate: number; skippedInvalid: number } {
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  const valid = records.filter((r) => {
    if (r.rinse?.duplicate) {
      skippedDuplicate++;
      return false;
    }
    if (r.scrub?.email?.valid === false) {
      skippedInvalid++;
      return false;
    }
    return true;
  });

  return { valid, skippedDuplicate, skippedInvalid };
}

/**
 * Detect if input data is in sink-cli format.
 * Returns 'envelope' for { stats, records }, 'array' for SinkRecord[],
 * or 'unknown' if not sink format.
 */
export function detectSinkFormat(
  data: unknown,
): "envelope" | "array" | "unknown" {
  if (
    data &&
    typeof data === "object" &&
    "records" in data &&
    Array.isArray((data as { records: unknown }).records)
  ) {
    return "envelope";
  }

  if (Array.isArray(data) && data.length > 0 && "raw" in data[0]) {
    return "array";
  }

  return "unknown";
}

/**
 * Extract SinkRecord[] from detected format.
 */
export function extractSinkRecords(
  data: unknown,
  format: "envelope" | "array",
): SinkRecord[] {
  if (format === "envelope") {
    return (data as { records: SinkRecord[] }).records;
  }
  return data as SinkRecord[];
}
