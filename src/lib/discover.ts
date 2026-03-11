/**
 * Contact discovery engine using Perplexity API.
 *
 * Adapted from scripts/liberty-agent/src/integrations/contact-discovery.ts.
 * Finds new radio/press contacts by station, genre, or region.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface DiscoveredContact {
  name: string;
  email: string | null;
  role: string | null;
  outlet: string | null;
  source: string | null;
  confidence: "high" | "medium" | "low";
}

interface DiscoverOpts {
  genre?: string;
  region?: string;
  station?: string;
  limit?: number;
}

/**
 * Discover contacts using Perplexity sonar-pro.
 */
export async function discoverContacts(
  query: string,
  opts: DiscoverOpts,
  apiKey: string,
): Promise<DiscoveredContact[]> {
  const parts: string[] = [];

  if (opts.station) {
    parts.push(`Find radio presenters, producers, and music programmers at ${opts.station}.`);
  } else if (query) {
    parts.push(`Find radio presenters, producers, and music programmers at or related to: ${query}.`);
  }

  if (opts.genre) parts.push(`Focus on ${opts.genre} music.`);
  if (opts.region) parts.push(`Focus on the ${opts.region} area.`);

  parts.push(
    `For each person, provide: full name, email address (if publicly available), job title/role, outlet/station name, and the source URL where you found this information.`,
    `Return results as a JSON array with fields: name, email, role, outlet, source.`,
    `Only include people who are likely to accept music submissions or pitches.`,
    `Prioritise contacts with publicly available email addresses.`,
    `Maximum ${opts.limit || 10} results.`,
  );

  const systemPrompt =
    "You are a music industry research assistant. Return ONLY valid JSON arrays, no markdown, no explanation.";

  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: parts.join(" ") },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity API error: ${response.status} ${text}`);
  }

  const result = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = result.choices?.[0]?.message?.content || "[]";

  // Extract JSON from response (may be wrapped in markdown code blocks)
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      name?: string;
      email?: string;
      role?: string;
      outlet?: string;
      source?: string;
    }>;

    return parsed
      .filter((p) => p.name)
      .map((p) => ({
        name: p.name!,
        email: p.email?.toLowerCase().trim() || null,
        role: p.role || null,
        outlet: p.outlet || null,
        source: p.source || null,
        confidence: scoreConfidence(p.source || "", p.email || null),
      }));
  } catch {
    return [];
  }
}

/**
 * Score confidence based on source and email presence.
 */
function scoreConfidence(
  source: string,
  email: string | null,
): "high" | "medium" | "low" {
  if (!email) return "low";

  const src = source.toLowerCase();
  if (
    src.includes("bbc.co.uk") ||
    src.includes("radiotoday") ||
    src.includes("ofcom") ||
    src.includes(".gov.uk")
  ) {
    return "high";
  }
  if (
    src.includes("linkedin") ||
    src.includes("twitter") ||
    src.includes("x.com") ||
    src.includes(".co.uk") ||
    src.includes(".com") ||
    src.includes("radio")
  ) {
    return "medium";
  }
  return "low";
}

/**
 * Deduplicate discovered contacts against existing workspace contacts.
 * Returns { newContacts, existingContacts }.
 */
export async function deduplicateContacts(
  supabase: SupabaseClient,
  workspaceId: string,
  discovered: DiscoveredContact[],
): Promise<{
  newContacts: DiscoveredContact[];
  existingContacts: Array<{
    name: string;
    email: string;
    warmth_level: string | null;
    pipeline_status: string | null;
    response_rate: number;
  }>;
}> {
  const emails = discovered
    .map((c) => c.email)
    .filter((e): e is string => e !== null);

  if (emails.length === 0) {
    return { newContacts: discovered, existingContacts: [] };
  }

  // Fetch existing contacts by email (single query with IDs for metrics lookup)
  const { data: existing } = await supabase
    .from("tap_contacts")
    .select("id, name, email, pipeline_status")
    .eq("workspace_id", workspaceId)
    .in("email", emails);

  const existingEmails = new Set((existing || []).map((c) => c.email));

  // Fetch metrics for existing contacts
  const existingWithMetrics: Array<{
    name: string;
    email: string;
    warmth_level: string | null;
    pipeline_status: string | null;
    response_rate: number;
  }> = [];

  if (existing && existing.length > 0) {
    const contactIds = existing.map((c) => c.id);
    const { data: metrics } = await supabase
      .from("contact_relationship_metrics")
      .select("contact_id, warmth_level, response_rate")
      .in("contact_id", contactIds);

    const metricsMap = new Map(
      (metrics || []).map((m) => [m.contact_id, m]),
    );

    for (const c of existing) {
      const m = metricsMap.get(c.id);
      existingWithMetrics.push({
        name: c.name || c.email,
        email: c.email,
        warmth_level: m?.warmth_level || null,
        pipeline_status: c.pipeline_status,
        response_rate: m?.response_rate || 0,
      });
    }
  }

  const newContacts = discovered.filter(
    (c) => !c.email || !existingEmails.has(c.email),
  );

  return { newContacts, existingContacts: existingWithMetrics };
}
