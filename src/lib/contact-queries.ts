/**
 * Reusable Supabase queries for contact data.
 *
 * Used by contacts show, history, interactive mode, and future MCP integration.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// -- Types --------------------------------------------------------------------

export interface ContactFull {
  id: string;
  name: string | null;
  email: string;
  outlet: string | null;
  role: string | null;
  role_detail: string | null;
  platform: string | null;
  platform_type: string | null;
  contact_method: string | null;
  bbc_station: string | null;
  bbc_shows: string[] | null;
  coverage_area: string | null;
  coverage_areas: string[] | null;
  coverage_region: string | null;
  geographic_scope: string | null;
  genres: string[] | null;
  tags: string[] | null;
  pitch_tips: string[] | null;
  enriched: boolean | null;
  enriched_at: string | null;
  enrichment_confidence: string | null;
  enrichment_source: string | null;
  enrichment_reasoning: string | null;
  submission_guidelines: string | null;
  best_timing: string | null;
  pitch_embargo_until: string | null;
  cooling_off: boolean | null;
  last_contacted_at: string | null;
  last_response_at: string | null;
  total_pitches: number | null;
  total_responses: number | null;
  pipeline_status: string | null;
  relationship_notes: string | null;
  notes: string | null;
  source: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ContactMetrics {
  warmth_score: number | null;
  warmth_level: string | null;
  response_rate: number;
  total_pitches: number;
  positive_outcomes: number;
  avg_response_days: number | null;
  last_contacted_at: string | null;
}

export interface ContactOutcome {
  id: string;
  outcome_type: string;
  notes: string | null;
  occurred_at: string | null;
  project_name: string | null;
  artist_name: string | null;
}

export interface ContactCampaign {
  project_id: string;
  project_name: string;
  artist_name: string | null;
  pitch_status: string | null;
  last_pitched_at: string | null;
  project_status: string | null;
}

export interface ContactCoverage {
  id: string;
  title: string;
  type: string;
  url: string | null;
  publish_date: string | null;
  status: string;
}

// -- Queries ------------------------------------------------------------------

export async function fetchContactFull(
  supabase: SupabaseClient,
  contactId: string,
): Promise<ContactFull | null> {
  const { data, error } = await supabase
    .from("tap_contacts")
    .select("*")
    .eq("id", contactId)
    .single();

  if (error || !data) return null;
  return data as ContactFull;
}

export async function fetchContactMetrics(
  supabase: SupabaseClient,
  contactId: string,
): Promise<ContactMetrics | null> {
  const { data, error } = await supabase
    .from("contact_relationship_metrics")
    .select(
      "warmth_score, warmth_level, response_rate, total_pitches, positive_outcomes, avg_response_days, last_contacted_at",
    )
    .eq("contact_id", contactId)
    .maybeSingle();

  if (error || !data) return null;
  return data as ContactMetrics;
}

export async function fetchContactOutcomes(
  supabase: SupabaseClient,
  contactId: string,
  limit = 10,
): Promise<ContactOutcome[]> {
  const { data, error } = await supabase
    .from("tap_contact_outcomes")
    .select("id, outcome_type, notes, occurred_at, project_id")
    .eq("contact_id", contactId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  // Resolve project names
  const projectIds = [...new Set(data.map((o) => o.project_id).filter(Boolean))];
  const projectMap = new Map<string, { name: string; artist_name: string | null }>();

  if (projectIds.length > 0) {
    const { data: projects } = await supabase
      .from("tap_projects")
      .select("id, name, artist_name")
      .in("id", projectIds);

    if (projects) {
      for (const p of projects) {
        projectMap.set(p.id, { name: p.name, artist_name: p.artist_name });
      }
    }
  }

  return data.map((o) => {
    const project = o.project_id ? projectMap.get(o.project_id) : null;
    return {
      id: o.id,
      outcome_type: o.outcome_type,
      notes: o.notes,
      occurred_at: o.occurred_at,
      project_name: project?.name || null,
      artist_name: project?.artist_name || null,
    };
  });
}

export async function fetchContactCampaigns(
  supabase: SupabaseClient,
  contactId: string,
): Promise<ContactCampaign[]> {
  const { data, error } = await supabase
    .from("campaign_contacts")
    .select("project_id, pitch_status, last_pitched_at")
    .eq("contact_id", contactId);

  if (error || !data || data.length === 0) return [];

  // Resolve project details
  const projectIds = [...new Set(data.map((c) => c.project_id))];
  const { data: projects } = await supabase
    .from("tap_projects")
    .select("id, name, artist_name, status")
    .in("id", projectIds);

  const projectMap = new Map(
    (projects || []).map((p) => [p.id, p]),
  );

  return data.map((c) => {
    const project = projectMap.get(c.project_id);
    return {
      project_id: c.project_id,
      project_name: project?.name || "Unknown",
      artist_name: project?.artist_name || null,
      pitch_status: c.pitch_status,
      last_pitched_at: c.last_pitched_at,
      project_status: project?.status || null,
    };
  });
}

export async function fetchContactCoverage(
  supabase: SupabaseClient,
  contactId: string,
  limit = 5,
): Promise<ContactCoverage[]> {
  const { data, error } = await supabase
    .from("coverage_clips")
    .select("id, title, type, url, publish_date, status")
    .eq("contact_id", contactId)
    .order("publish_date", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as ContactCoverage[];
}

export async function resolveContactByEmail(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("tap_contacts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("email", email.toLowerCase().trim())
    .maybeSingle();

  if (error || !data) return null;
  return data.id;
}
