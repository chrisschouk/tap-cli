/**
 * Pitch command -- generate AI pitch drafts from the terminal.
 *
 * Usage:
 *   tap pitch <campaign-id>                    # interactive contact selection
 *   tap pitch <campaign-id> <contact-id>       # specific contact
 *   tap pitch <campaign-id> --tone casual      # pick the tone
 *
 * TAP generates and saves the draft. Approving and sending it happen in TAP;
 * see `tap send <campaign-id>`.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import { COLOUR } from "../ui/theme.js";
import { createRailSpinner, divider, blank } from "../ui/format.js";
import { handleError } from "../ui/errors.js";
import { navHint } from "../ui/detail.js";

export function pitchCommand(): Command {
  return new Command("pitch")
    .description("Generate AI pitch drafts for a campaign")
    .argument("<campaign-id>", "Campaign ID")
    .argument("[contact-id]", "Contact ID (interactive selection if omitted)")
    .option(
      "--tone <tone>",
      "Tone: professional, casual, enthusiastic",
      "professional",
    )
    .option("--dry-run", "Show what would be generated without generating")
    .option("--json", "Output as JSON")
    .action(async (campaignId, contactId, opts) => {
      try {
        // If no contact ID, show interactive selection
        if (!contactId) {
          const spinner = createRailSpinner("Fetching campaign contacts...").start();
          const contactsRes = await restRequest<{ contacts: any[] }>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/contacts`, {
            query: { limit: 100 },
          });
          spinner.stop();

          const unpitched = contactsRes.contacts.filter(c => !c.pitch_status || c.pitch_status === "not_pitched");

          if (unpitched.length === 0) {
            out.info("No unpitched contacts in this campaign");
            return;
          }

          const selected = await prompts.select({
            message: "Select a contact to pitch",
            options: unpitched.map((c) => ({
              value: c.contact?.id,
              label: `${c.contact?.name || c.contact?.email}${c.contact?.outlet ? ` — ${c.contact?.outlet}` : ""}`,
            })),
          });

          if (prompts.isCancel(selected)) {
            out.info("Cancelled");
            return;
          }

          contactId = selected as string;
        }

        if (opts.dryRun) {
          out.info(`Dry run -- would generate pitch for campaign ${campaignId} contact ${contactId}`);
          return;
        }

        // Generate
        const genSpinner = createRailSpinner("Generating pitch draft on TAP...").start();
        const res = await restRequest<{
          drafts: Array<{
            contact_id: string;
            contact_name: string;
            variants: Array<{ subject: string; body: string; tone: string }>;
          }>;
          errors?: Array<{ contact_id: string; error: string }>;
          skipped?: Array<{ contact_id: string; reason: string }>;
        }>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/pitches`, {
          method: "POST",
          body: {
            contact_ids: [contactId],
            tone: opts.tone,
          },
        });
        genSpinner.stop();

        if (res.errors && res.errors.length > 0) {
          out.error(`Generation failed: ${res.errors[0].error}`);
          process.exit(1);
        }

        const draft = res.drafts?.[0];
        if (!draft) {
          out.error(res.skipped?.[0] ? `Skipped: ${res.skipped[0].reason}` : "No draft returned");
          process.exit(1);
        }

        if (opts.json) {
          out.json(draft);
          return;
        }

        console.log("");
        console.log(`  ${chalk.bold("Subject:")} ${draft.variants[0]?.subject || "New Pitch"}`);
        console.log(`  ${chalk.dim(`To: ${draft.contact_name}`)}`);
        console.log("");

        for (const variant of draft.variants) {
          divider();
          console.log(`  ${chalk.hex(COLOUR.primary)(variant.tone)}`);
          console.log("");
          for (const line of variant.body.split("\n")) {
            console.log(`  ${line}`);
          }
          console.log("");
        }

        navHint([`tap send ${campaignId}`]);
        blank();
      } catch (err) {
        handleError(err);
        process.exit(1);
      }
    });
}
