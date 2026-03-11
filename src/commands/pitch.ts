/**
 * Pitch command -- generate AI pitch drafts from the terminal.
 *
 * Usage:
 *   tap pitch <campaign-id>                    # interactive contact selection
 *   tap pitch <campaign-id> <contact-id>       # specific contact
 *   tap pitch <campaign-id> --dry-run          # show context without generating
 *   tap pitch <campaign-id> --hook "BBC 6 Music session artist"
 */

import { Command } from "commander";
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { getClient, resolveWorkspaceId, getAnthropicKey } from "../auth.js";
import * as out from "../output.js";
import { GLYPH, COLOUR } from "../ui/theme.js";
import { createRailSpinner, divider } from "../ui/format.js";
import {
  gatherPitchContext,
  getUnpitchedContacts,
} from "../lib/pitch-context.js";
import {
  generateAIPitch,
  type PitchGenerateInput,
} from "../lib/ai-generator.js";

export function pitchCommand(): Command {
  return new Command("pitch")
    .description("Generate AI pitch drafts for a campaign")
    .argument("<campaign-id>", "Campaign ID")
    .argument("[contact-id]", "Contact ID (interactive selection if omitted)")
    .option("--hook <text>", "Key hook for the pitch")
    .option(
      "--tone <tone>",
      "Tone: professional, casual, enthusiastic",
      "professional",
    )
    .option("--dry-run", "Show gathered context without generating")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (campaignId, contactId, opts) => {
      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        // If no contact ID, show interactive selection
        if (!contactId) {
          const spinner = createRailSpinner(
            "Fetching unpitched contacts...",
          ).start();
          const unpitched = await getUnpitchedContacts(
            supabase,
            campaignId,
            10,
          );
          spinner.stop();

          if (unpitched.length === 0) {
            out.info("No unpitched contacts in this campaign");
            return;
          }

          const selected = await prompts.select({
            message: "Select a contact to pitch",
            options: unpitched.map((c) => ({
              value: c.id,
              label: `${c.name}${c.outlet ? ` — ${c.outlet}` : ""}`,
              hint: c.enriched_at ? "enriched" : undefined,
            })),
          });

          if (prompts.isCancel(selected)) {
            out.info("Cancelled");
            return;
          }

          contactId = selected as string;
        }

        // Gather context
        const contextSpinner = createRailSpinner(
          "Gathering pitch context...",
        ).start();
        const ctx = await gatherPitchContext(
          supabase,
          campaignId,
          contactId,
          wsId,
        );
        contextSpinner.succeed(
          `Context: ${ctx.contactName}${ctx.contactOutlet ? ` at ${ctx.contactOutlet}` : ""}`,
        );

        // Dry run — show context and exit
        if (opts.dryRun) {
          console.log("");
          console.log(chalk.bold("  Pitch Context"));
          divider();
          console.log(`  ${chalk.dim("Campaign")}   ${ctx.campaignName}`);
          console.log(`  ${chalk.dim("Artist")}     ${ctx.artistName}`);
          console.log(`  ${chalk.dim("Release")}    ${ctx.releaseName}`);
          if (ctx.releaseDate) {
            console.log(
              `  ${chalk.dim("Date")}       ${new Date(ctx.releaseDate).toLocaleDateString("en-GB")}`,
            );
          }
          if (ctx.genre)
            console.log(`  ${chalk.dim("Genre")}      ${ctx.genre}`);
          console.log("");
          console.log(`  ${chalk.dim("Contact")}    ${ctx.contactName}`);
          if (ctx.contactOutlet)
            console.log(`  ${chalk.dim("Outlet")}     ${ctx.contactOutlet}`);
          if (ctx.contactRole)
            console.log(`  ${chalk.dim("Role")}       ${ctx.contactRole}`);
          if (ctx.contactWarmth)
            console.log(
              `  ${chalk.dim("Warmth")}     ${out.warmthBadge(ctx.contactWarmth)}`,
            );
          if (ctx.contactPitchCount)
            console.log(
              `  ${chalk.dim("Prior pitches")} ${ctx.contactPitchCount}`,
            );
          if (ctx.contactBbcStation)
            console.log(
              `  ${chalk.dim("BBC")}        ${ctx.contactBbcStation}`,
            );
          if (ctx.contactGenres?.length)
            console.log(
              `  ${chalk.dim("Genres")}     ${ctx.contactGenres.join(", ")}`,
            );
          if (ctx.contactSubmissionGuidelines)
            console.log(
              `  ${chalk.dim("Guidelines")} ${out.truncate(ctx.contactSubmissionGuidelines, 60)}`,
            );
          if (ctx.isStaleEnrichment)
            console.log(
              `  ${chalk.yellow("!")} Enrichment data is stale (>90 days)`,
            );
          if (ctx.pastLearnings) {
            console.log("");
            console.log(`  ${chalk.dim("Learnings")}`);
            for (const line of ctx.pastLearnings.split("\n")) {
              console.log(`  ${chalk.dim(GLYPH.dot)} ${line}`);
            }
          }
          if (ctx.voiceProfile) {
            const hasVoice = Object.values(ctx.voiceProfile).some((v) => v);
            if (hasVoice)
              console.log(
                `  ${chalk.dim("Voice")}      ${chalk.green("configured")}`,
              );
          }
          console.log("");
          return;
        }

        // Get key hook — prompt interactively if not provided
        let keyHook = opts.hook as string | undefined;
        if (!keyHook) {
          const hookInput = await prompts.text({
            message:
              "Key hook for this pitch (what makes this release special?)",
            placeholder:
              "e.g. BBC 6 Music session artist, debut single, festival headliner",
            validate: (value) => {
              if (!value || value.trim().length < 3)
                return "Hook is required (min 3 chars)";
              return undefined;
            },
          });

          if (prompts.isCancel(hookInput)) {
            out.info("Cancelled");
            return;
          }

          keyHook = hookInput as string;
        }

        // Validate tone
        const validTones = ["professional", "casual", "enthusiastic"] as const;
        if (!validTones.includes(opts.tone)) {
          out.error(`Invalid tone. Must be: ${validTones.join(", ")}`);
          process.exit(1);
        }

        // Check for Anthropic key
        const apiKey = getAnthropicKey();
        if (!apiKey) {
          out.error(
            "ANTHROPIC_API_KEY not set. Add it to ~/.tap/config.json or set the environment variable.",
          );
          process.exit(1);
        }

        // Build input
        const input: PitchGenerateInput = {
          artistName: ctx.artistName,
          releaseName: ctx.releaseName,
          releaseDate: ctx.releaseDate,
          genre: ctx.genre,
          brief: ctx.brief,
          channels: ctx.channels,
          contactName: ctx.contactName,
          contactOutlet: ctx.contactOutlet,
          contactRole: ctx.contactRole,
          contactWarmth:
            ctx.contactWarmth as PitchGenerateInput["contactWarmth"],
          contactPitchCount: ctx.contactPitchCount,
          contactLastPitchedAt: ctx.contactLastPitchedAt,
          contactPreviousCampaigns: ctx.contactPreviousCampaigns,
          contactSubmissionGuidelines: ctx.contactSubmissionGuidelines,
          contactGenres: ctx.contactGenres,
          contactPitchTips: ctx.contactPitchTips,
          contactBestTiming: ctx.contactBestTiming,
          contactPlatformType: ctx.contactPlatformType,
          contactGeographicScope: ctx.contactGeographicScope,
          contactBbcStation: ctx.contactBbcStation,
          isStaleEnrichment: ctx.isStaleEnrichment,
          pressReleaseContent: ctx.pressReleaseContent,
          pastLearnings: ctx.pastLearnings,
          keyHook,
          tone: opts.tone as "professional" | "casual" | "enthusiastic",
          voiceProfile: ctx.voiceProfile as PitchGenerateInput["voiceProfile"],
        };

        // Generate
        const genSpinner = createRailSpinner(
          "Generating pitch variants...",
        ).start();
        const result = await generateAIPitch(input, apiKey);
        genSpinner.succeed("3 variants generated");

        // Save draft to DB
        const saveSpinner = createRailSpinner("Saving draft...").start();
        const { data: draft, error: saveErr } = await supabase
          .from("campaign_pitch_drafts")
          .insert({
            workspace_id: wsId,
            project_id: campaignId,
            contact_id: contactId,
            subject: result.subject,
            body: result.body,
            variants: result.variants || null,
            tone: opts.tone,
            key_hook: keyHook,
            source: "ai",
            send_status: "draft",
          })
          .select("id")
          .single();

        if (saveErr) {
          saveSpinner.fail("Failed to save draft");
          out.error(saveErr.message);
        } else {
          saveSpinner.succeed(`Draft saved (${draft.id.slice(0, 8)}...)`);
        }

        // Output
        if (opts.json) {
          out.json({
            draftId: draft?.id,
            subject: result.subject,
            variants: result.variants,
            contact: { id: contactId, name: ctx.contactName },
          });
          return;
        }

        // Display pitches in a clean, copy-friendly format
        console.log("");
        console.log(`  ${chalk.bold("Subject:")} ${result.subject}`);
        console.log(
          `  ${chalk.dim(`To: ${ctx.contactName}${ctx.contactOutlet ? ` at ${ctx.contactOutlet}` : ""}`)}`,
        );
        console.log("");

        if (result.variants) {
          const variants = [
            { label: "Direct", body: result.variants.direct },
            { label: "Story", body: result.variants.story },
            { label: "Value", body: result.variants.value },
          ];

          for (const variant of variants) {
            if (!variant.body) continue;
            divider();
            console.log(`  ${chalk.hex(COLOUR.primary)(variant.label)}`);
            console.log("");
            // Print body without colour codes so it's copy-pasteable
            for (const line of variant.body.split("\n")) {
              console.log(`  ${line}`);
            }
            console.log("");
          }
        } else {
          divider();
          for (const line of result.body.split("\n")) {
            console.log(`  ${line}`);
          }
          console.log("");
        }
      } catch (err) {
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });
}
