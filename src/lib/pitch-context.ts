/**
 * Gather context from Supabase for pitch generation.
 *
 * Fetches campaign, contact, enrichment, voice profile, and past learnings
 * to build the most personalised pitch possible.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// Typed shapes matching the select() columns used in gatherPitchContext.
// Minimal — only the fields actually accessed in this file.

interface CampaignRow {
  name: string;
  artist_name: string | null;
  release_name: string | null;
  release_date: string | null;
  goal: string | null;
  services: string[] | null;
  memory_what_worked: string | null;
  memory_what_didnt: string | null;
  memory_next_release: string | null;
}

interface ContactRow {
  id: string;
  name: string;
  email: string;
  outlet: string | null;
  role: string | null;
  genres: string[] | null;
  submission_guidelines: string | null;
  pitch_tips: string[] | null;
  best_timing: string | null;
  platform_type: string | null;
  geographic_scope: string | null;
  bbc_station: string | null;
  enriched_at: string | null;
}

interface CampaignContactRow {
  pitch_status: string | null;
  last_pitched_at: string | null;
}

interface WarmthRow {
  warmth_level: string | null;
}

interface PrevCampaignRow {
  project_id: string;
  tap_projects: { name: string } | { name: string }[] | null;
}

interface VoiceRow {
  voice_background: string | null;
  voice_style: string | null;
  voice_typical_opener: string | null;
  voice_approach: string | null;
  voice_differentiator: string | null;
  voice_achievements: string | null;
  voice_context_notes: string | null;
}

interface PressReleaseRow {
  content: string | null;
}

interface UnpitchedRow {
  contact_id: string;
  tap_contacts: UnpitchedContact | UnpitchedContact[] | null;
}

export interface PitchContext {
  // Campaign
  campaignName: string;
  artistName: string;
  releaseName: string;
  releaseDate?: string;
  genre?: string;
  brief?: string;
  channels?: string[];
  pastLearnings?: string;

  // Contact
  contactId: string;
  contactName: string;
  contactEmail: string;
  contactOutlet?: string;
  contactRole?: string;
  contactWarmth?: string;
  contactPitchCount?: number;
  contactLastPitchedAt?: string;
  contactPreviousCampaigns?: string[];

  // Enrichment
  contactSubmissionGuidelines?: string;
  contactGenres?: string[];
  contactPitchTips?: string[];
  contactBestTiming?: string;
  contactPlatformType?: string;
  contactGeographicScope?: string;
  contactBbcStation?: string;
  isStaleEnrichment?: boolean;

  // Press release
  pressReleaseContent?: string;

  // Voice
  voiceProfile?: Record<string, string | null | undefined> | null;
}

export interface UnpitchedContact {
  id: string;
  name: string;
  email: string;
  outlet: string | null;
  enriched_at: string | null;
}

/**
 * Fetch unpitched contacts for a campaign (enriched first, then alphabetical).
 */
export async function getUnpitchedContacts(
  supabase: SupabaseClient,
  campaignId: string,
  limit = 10,
): Promise<UnpitchedContact[]> {
  const { data } = await supabase
    .from("campaign_contacts")
    .select("contact_id, tap_contacts(id, name, email, outlet, enriched_at)")
    .eq("project_id", campaignId)
    .eq("pitch_status", "not_pitched")
    .limit(limit);

  if (!data) return [];

  return (data as UnpitchedRow[])
    .filter((r) => r.tap_contacts)
    .map((r) => {
      const c = Array.isArray(r.tap_contacts)
        ? r.tap_contacts[0]
        : r.tap_contacts;
      return c as UnpitchedContact;
    })
    .sort((a, b) => {
      // Enriched contacts first
      if (a.enriched_at && !b.enriched_at) return -1;
      if (!a.enriched_at && b.enriched_at) return 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Gather full context for pitch generation.
 */
export async function gatherPitchContext(
  supabase: SupabaseClient,
  campaignId: string,
  contactId: string,
  wsId: string,
): Promise<PitchContext> {
  // Fetch campaign + contact in parallel
  const [campaignRes, contactRes, ccRes, warmthRes] = await Promise.all([
    supabase
      .from("tap_projects")
      .select(
        "name, artist_name, release_name, release_date, goal, services, " +
          "memory_what_worked, memory_what_didnt, memory_next_release",
      )
      .eq("id", campaignId)
      .single(),
    supabase
      .from("tap_contacts")
      .select(
        "id, name, email, outlet, role, genres, " +
          "submission_guidelines, pitch_tips, best_timing, " +
          "platform_type, geographic_scope, bbc_station, enriched_at",
      )
      .eq("id", contactId)
      .single(),
    supabase
      .from("campaign_contacts")
      .select("pitch_status, last_pitched_at")
      .eq("project_id", campaignId)
      .eq("contact_id", contactId)
      .maybeSingle(),
    supabase
      .from("contact_relationship_metrics")
      .select("warmth_level")
      .eq("contact_id", contactId)
      .eq("workspace_id", wsId)
      .maybeSingle(),
  ]);

  const campaign = campaignRes.data as CampaignRow | null;
  const contact = contactRes.data as ContactRow | null;
  const cc = ccRes.data as CampaignContactRow | null;
  const warmthLevel = (warmthRes.data as WarmthRow | null)?.warmth_level ?? undefined;

  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
  if (!contact) throw new Error(`Contact not found: ${contactId}`);

  // Fetch remaining context in parallel (none depend on each other)
  const [
    { count: pitchCount },
    { data: prevCampaigns },
    { data: voiceData },
    { data: pressRelease },
  ] = await Promise.all([
    // Count previous pitches to this contact across all campaigns
    supabase
      .from("campaign_contacts")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", contactId)
      .not("pitch_status", "eq", "not_pitched"),
    // Get previous campaign names for this contact
    supabase
      .from("campaign_contacts")
      .select("project_id, tap_projects(name)")
      .eq("contact_id", contactId)
      .not("project_id", "eq", campaignId)
      .not("pitch_status", "eq", "not_pitched")
      .limit(5),
    // Fetch voice profile for workspace
    supabase
      .from("workspaces")
      .select(
        "voice_background, voice_style, voice_typical_opener, voice_approach, " +
          "voice_differentiator, voice_achievements, voice_context_notes",
      )
      .eq("id", wsId)
      .single(),
    // Fetch press release if available
    supabase
      .from("campaign_assets")
      .select("content")
      .eq("project_id", campaignId)
      .eq("type", "press_release")
      .limit(1)
      .maybeSingle(),
  ]);

  const previousCampaignNames =
    (prevCampaigns as PrevCampaignRow[] | null)
      ?.filter((p) => p.tap_projects)
      .map((p) => {
        const proj = Array.isArray(p.tap_projects)
          ? p.tap_projects[0]
          : p.tap_projects;
        return proj?.name;
      })
      .filter((n): n is string => Boolean(n)) || [];

  // Build past learnings from campaign memory
  const learningParts: string[] = [];
  if (campaign.memory_what_worked) {
    learningParts.push(`What worked: ${campaign.memory_what_worked}`);
  }
  if (campaign.memory_what_didnt) {
    learningParts.push(`What didn't work: ${campaign.memory_what_didnt}`);
  }
  if (campaign.memory_next_release) {
    learningParts.push(
      `Notes for next release: ${campaign.memory_next_release}`,
    );
  }

  // Check for stale enrichment (>90 days old)
  const isStale = contact.enriched_at
    ? Date.now() - new Date(contact.enriched_at).getTime() >
      90 * 24 * 60 * 60 * 1000
    : false;

  return {
    campaignName: campaign.name,
    artistName: campaign.artist_name || "Unknown Artist",
    releaseName: campaign.release_name || campaign.name,
    releaseDate: campaign.release_date || undefined,
    genre: contact.genres?.[0] || undefined,
    brief: campaign.goal || undefined,
    channels: campaign.services || undefined,
    pastLearnings:
      learningParts.length > 0 ? learningParts.join("\n") : undefined,

    contactId: contact.id,
    contactName: contact.name,
    contactEmail: contact.email,
    contactOutlet: contact.outlet || undefined,
    contactRole: contact.role || undefined,
    contactWarmth: warmthLevel || undefined,
    contactPitchCount: pitchCount || 0,
    contactLastPitchedAt: cc?.last_pitched_at || undefined,
    contactPreviousCampaigns:
      previousCampaignNames.length > 0 ? previousCampaignNames : undefined,

    contactSubmissionGuidelines: contact.submission_guidelines || undefined,
    contactGenres: contact.genres || undefined,
    contactPitchTips: contact.pitch_tips || undefined,
    contactBestTiming: contact.best_timing || undefined,
    contactPlatformType: contact.platform_type || undefined,
    contactGeographicScope: contact.geographic_scope || undefined,
    contactBbcStation: contact.bbc_station || undefined,
    isStaleEnrichment: isStale,

    pressReleaseContent: (pressRelease as PressReleaseRow | null)?.content || undefined,
    voiceProfile: (voiceData as VoiceRow | null) as Record<string, string | null | undefined> | null,
  };
}
