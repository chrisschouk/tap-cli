/**
 * Gather context from Supabase for pitch generation.
 *
 * Fetches campaign, contact, enrichment, voice profile, and past learnings
 * to build the most personalised pitch possible.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data as any[])
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
  const [campaignRes, contactRes, ccRes] = await Promise.all([
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
        "id, name, email, outlet, role, warmth, genres, " +
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
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const campaign = campaignRes.data as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contact = contactRes.data as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cc = ccRes.data as any;

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const previousCampaignNames =
    (prevCampaigns as any[] | null)
      ?.filter((p) => p.tap_projects)
      .map((p) => {
        const proj = Array.isArray(p.tap_projects)
          ? p.tap_projects[0]
          : p.tap_projects;
        return proj?.name as string;
      })
      .filter(Boolean) || [];

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
    contactWarmth: contact.warmth || undefined,
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pressReleaseContent: (pressRelease as any)?.content || undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    voiceProfile: (voiceData as any) || null,
  };
}
