/**
 * AI Pitch Generator
 *
 * Generates personalised pitch drafts using Claude Sonnet.
 *
 * Adapted from apps/tap/lib/pitch-drafts/ai-generator.ts in the TAP monorepo.
 * Self-contained -- no monorepo imports.
 */

import Anthropic from "@anthropic-ai/sdk";

// ============================================
// TYPES
// ============================================

type WarmthLevel = "hot" | "warm" | "neutral" | "cold" | "over_pitched";

export interface VoiceProfile {
  voice_background?: string | null;
  voice_style?: string | null;
  voice_typical_opener?: string | null;
  voice_approach?: string | null;
  voice_differentiator?: string | null;
  voice_achievements?: string | null;
  voice_context_notes?: string | null;
}

export interface PitchGenerateInput {
  // Campaign context
  artistName: string;
  releaseName: string;
  releaseDate?: string;
  genre?: string;
  brief?: string;
  channels?: string[];

  // Contact context
  contactName: string;
  contactOutlet?: string;
  contactRole?: string;
  contactWarmth?: WarmthLevel;
  contactPitchCount?: number;
  contactLastPitchedAt?: string;
  contactPreviousCampaigns?: string[];

  // Enrichment intelligence
  contactSubmissionGuidelines?: string;
  contactGenres?: string[];
  contactPitchTips?: string[];
  contactBestTiming?: string;
  contactPlatformType?: string;
  contactGeographicScope?: string;
  contactBbcStation?: string;
  isStaleEnrichment?: boolean;

  // Press release content
  pressReleaseContent?: string;

  // Campaign memory
  pastLearnings?: string;

  // Generation params
  keyHook: string;
  tone: "casual" | "professional" | "enthusiastic";
  voiceProfile?: VoiceProfile | null;
}

export interface PitchGenerateResult {
  subject: string;
  body: string;
  variants?: {
    direct: string;
    story: string;
    value: string;
  };
}

// ============================================
// CONSTANTS
// ============================================

const MODEL = "claude-sonnet-4-5-20250514";
const MAX_TIMEOUT = 30_000; // CLI can afford slightly longer timeout
const MAX_RETRIES = 2;

// ============================================
// SYSTEM PROMPT
// ============================================

function buildSystemPrompt(input: PitchGenerateInput): string {
  const { voiceProfile, pastLearnings } = input;

  let prompt = `You are an expert UK music PR professional writing a personalised pitch email. You write natural, human-sounding emails that get responses. You avoid corporate speak and hype language.`;

  // Voice profile injection
  if (voiceProfile) {
    const fieldLabels: [keyof VoiceProfile, string][] = [
      ["voice_background", "Background"],
      ["voice_style", "Writing style"],
      ["voice_typical_opener", "Typical opener"],
      ["voice_approach", "Approach"],
      ["voice_differentiator", "What makes me different"],
      ["voice_achievements", "Key achievements"],
      ["voice_context_notes", "Context"],
    ];
    const voiceParts = fieldLabels
      .filter(([key]) => voiceProfile[key])
      .map(([key, label]) => `- ${label}: ${voiceProfile[key]}`);

    if (voiceParts.length > 0) {
      prompt += `\n\nVOICE PROFILE (match this writing style):\n${voiceParts.join("\n")}\nWrite in this person's natural voice while maintaining professionalism and UK music industry tone.`;
    }
  }

  // Past learnings injection (campaign memory)
  if (pastLearnings) {
    prompt += `\n\nIMPORTANT - Learnings from previous campaigns with this artist:\n${pastLearnings}\n\nUse these insights to inform your pitch approach. Apply what worked before and avoid what didn't.`;
  }

  return prompt;
}

// ============================================
// USER PROMPT
// ============================================

function buildUserPrompt(input: PitchGenerateInput): string {
  const {
    artistName,
    releaseName,
    releaseDate,
    genre,
    brief,
    channels,
    contactName,
    contactOutlet,
    contactRole,
    contactWarmth,
    contactPitchCount,
    contactLastPitchedAt,
    contactPreviousCampaigns,
    contactSubmissionGuidelines,
    contactGenres,
    contactPitchTips,
    contactBestTiming,
    contactPlatformType,
    contactGeographicScope,
    contactBbcStation,
    isStaleEnrichment,
    pressReleaseContent,
    keyHook,
    tone,
  } = input;

  // Contact context
  let contactContext = "";
  if (contactWarmth === "hot") {
    contactContext +=
      "- Relationship: Strong recent engagement -- use a familiar, warm tone\n";
  } else if (contactWarmth === "warm") {
    contactContext +=
      "- Relationship: Recent positive interaction -- friendly but professional\n";
  } else if (contactWarmth === "cold") {
    contactContext +=
      "- Relationship: No recent contact -- reintroduce yourself naturally\n";
  } else if (contactWarmth === "over_pitched") {
    contactContext +=
      "- CAUTION: This contact has been pitched frequently. Keep it short, offer something genuinely different, acknowledge you reach out a lot\n";
  }

  if (contactPitchCount && contactPitchCount > 0) {
    contactContext += `- Previous pitches to this contact: ${contactPitchCount}\n`;
  }

  if (contactLastPitchedAt) {
    const lastDate = new Date(contactLastPitchedAt).toLocaleDateString(
      "en-GB",
      {
        month: "long",
        year: "numeric",
      },
    );
    contactContext += `- Last pitched: ${lastDate}\n`;
  }

  if (contactPreviousCampaigns && contactPreviousCampaigns.length > 0) {
    contactContext += `- Previous campaigns pitched: ${contactPreviousCampaigns.slice(0, 3).join(", ")}\n`;
  }

  if (isStaleEnrichment) {
    contactContext += `- WARNING: Contact data is stale (>90 days old). Details may be outdated.\n`;
  }

  // Enrichment intelligence
  let enrichmentContext = "";
  const enrichmentParts: string[] = [];

  if (contactPlatformType) {
    enrichmentParts.push(`- Platform type: ${contactPlatformType}`);
  }
  if (contactBbcStation) {
    enrichmentParts.push(
      `- BBC station: ${contactBbcStation} -- reference the station naturally`,
    );
  }
  if (contactGeographicScope) {
    enrichmentParts.push(`- Geographic scope: ${contactGeographicScope}`);
  }
  if (contactGenres && contactGenres.length > 0) {
    enrichmentParts.push(`- Their genre coverage: ${contactGenres.join(", ")}`);
  }
  if (contactBestTiming) {
    enrichmentParts.push(`- Best timing: ${contactBestTiming}`);
  }
  if (contactSubmissionGuidelines) {
    enrichmentParts.push(
      `- Submission guidelines: ${contactSubmissionGuidelines}`,
    );
  }
  if (contactPitchTips && contactPitchTips.length > 0) {
    enrichmentParts.push(`- Pitch tips: ${contactPitchTips.join("; ")}`);
  }

  if (enrichmentParts.length > 0) {
    enrichmentContext = `\nENRICHMENT INTELLIGENCE (use this to personalise):\n${enrichmentParts.join("\n")}\n`;
  }

  // Channel context
  let channelContext = "";
  if (channels && channels.length > 0) {
    const channelMap: Record<string, string> = {
      radio: "Radio plugging -- mention their station/show naturally",
      press: "Press pitch -- reference their publication style",
      playlists:
        "Playlist submission -- focus on track fit and listener appeal",
      influencers: "Creator briefing -- emphasise visual/content potential",
      sync: "Sync submission -- highlight mood, tempo, lyrical themes",
    };
    const relevant = channels
      .map((c) => channelMap[c])
      .filter(Boolean)
      .join("\n- ");
    if (relevant) {
      channelContext = `\nCHANNEL CONTEXT:\n- ${relevant}\n`;
    }
  }

  // Release date
  const releaseLine = releaseDate
    ? `- Release date: ${new Date(releaseDate).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
    : "";

  return `Write a pitch email to ${contactName}${contactOutlet ? ` at ${contactOutlet}` : ""}${contactRole ? ` (${contactRole})` : ""}.

CONTACT CONTEXT:
${contactContext || "- No previous interaction data\n"}
${enrichmentContext}${channelContext}ARTIST INFORMATION:
- Artist: ${artistName}
- Release: "${releaseName}"
${genre ? `- Genre: ${genre}` : ""}
- Key hook: ${keyHook}
${releaseLine}
${brief ? `\nCAMPAIGN BRIEF:\n${brief.slice(0, 500)}\n` : ""}${pressReleaseContent ? `\nPRESS RELEASE (use key facts and quotes from this, but DO NOT copy it wholesale):\n${pressReleaseContent.slice(0, 1000)}\n` : ""}
TONE: ${tone}

CRITICAL RULES:
1. Keep the pitch body under 150 words
2. Include the key hook prominently in the first 50 words
3. Sound conversational, not robotic -- use contractions (don't, can't, I'm)
4. NO buzzwords, hype language, or marketing speak
5. End with a clear, simple call-to-action
6. If the key hook mentions specific genres/eras, all musical references must match
7. Reference the contact's outlet naturally if relevant
8. UK music industry tone throughout
9. If submission guidelines are provided, follow them (format, length, what to include)
10. If pitch tips are provided, incorporate them naturally

Generate THREE variants with different approaches:

---SUBJECT---
[A single subject line under 50 characters, personal and direct]
---VARIANT 1---
[DIRECT: Straightforward pitch that gets to the point]
---VARIANT 2---
[STORY: Narrative approach about the artist or track]
---VARIANT 3---
[VALUE: Focus on what's in it for the contact -- exclusivity, audience fit]
---END---`;
}

// ============================================
// PARSER
// ============================================

function parseResponse(text: string): PitchGenerateResult {
  // Extract subject
  const subjectMatch = text.match(
    /---SUBJECT---\s*([\s\S]*?)\s*---VARIANT 1---/,
  );
  const subject =
    subjectMatch?.[1]?.trim() || "New music for your consideration";

  // Extract variants
  const v1Match = text.match(/---VARIANT 1---\s*([\s\S]*?)\s*---VARIANT 2---/);
  const v2Match = text.match(/---VARIANT 2---\s*([\s\S]*?)\s*---VARIANT 3---/);
  const v3Match = text.match(/---VARIANT 3---\s*([\s\S]*?)\s*---END---/);

  const direct = v1Match?.[1]?.trim() || text.trim();
  const story = v2Match?.[1]?.trim() || "";
  const value = v3Match?.[1]?.trim() || "";

  return {
    subject,
    body: direct,
    variants:
      story || value
        ? {
            direct,
            story,
            value,
          }
        : undefined,
  };
}

// ============================================
// GENERATOR
// ============================================

export async function generateAIPitch(
  input: PitchGenerateInput,
  apiKey: string,
): Promise<PitchGenerateResult> {
  const client = new Anthropic({ apiKey, timeout: MAX_TIMEOUT });
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        temperature: 0.8,
        system: buildSystemPrompt(input),
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      });

      const textBlock = response.content.find(
        (block): block is Anthropic.Messages.TextBlock => block.type === "text",
      );

      if (!textBlock) {
        throw new Error("No text response from AI");
      }

      return parseResponse(textBlock.text);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError
      ) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      break;
    }
  }

  throw lastError || new Error("Pitch generation failed after retries");
}
