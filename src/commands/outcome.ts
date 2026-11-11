/**
 * Outcome command -- log campaign outcomes from the terminal.
 *
 * Usage:
 *   tap outcome <campaign-id> <contact-id> <type>
 *   tap outcome <campaign-id> <contact-id> replied_positive --notes "Loved it, wants exclusive"
 *   tap outcome <campaign-id> <contact-id> coverage --channel radio
 */

import { Command } from "commander";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import { handleError } from "../ui/errors.js";
import { navHint } from "../ui/detail.js";
import { blank } from "../ui/format.js";
import { VALID_OUTCOME_TYPES, parseOutcomeType } from "../lib/outcome-mapping.js";

export function outcomeCommand(): Command {
  return new Command("outcome")
    .description("Log a campaign outcome for a contact")
    .argument("<campaign-id>", "Campaign ID")
    .argument("<contact-id>", "Contact ID")
    .argument("<type>", `Outcome type: ${VALID_OUTCOME_TYPES.join(", ")}`)
    .option("-n, --notes <text>", "Notes about the outcome")
    .option("-c, --channel <channel>", "Channel (radio, press, playlist, sync)")
    .option("--dry-run", "Preview without saving")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  tap outcome abc123 def456 replied_positive --notes "Loved it, wants exclusive"
  tap outcome abc123 def456 coverage --channel radio
  tap outcome abc123 def456 declined --dry-run`)
    .action(async (campaignId, contactId, type, opts) => {
      const outcomeType = parseOutcomeType(type);
      if (!outcomeType) {
        out.error(`Invalid outcome type: "${type}"`);
        out.info(`Valid types: ${VALID_OUTCOME_TYPES.join(", ")}`);
        process.exit(1);
      }

      const spinner = out.spinner("Logging outcome...");

      try {
        if (opts.dryRun) {
          spinner.stop();
          out.info(`Dry run -- would log "${outcomeType}" for contact ${contactId} in campaign ${campaignId}`);
          if (opts.notes) out.info(`Notes: ${opts.notes}`);
          return;
        }

        const res = await restRequest<{ id: string }>("/api/v1/outcomes", {
          method: "POST",
          body: {
            campaign_id: campaignId,
            contact_id: contactId,
            outcome_type: outcomeType,
            notes: opts.notes || undefined,
            channel: opts.channel || undefined,
          },
        });

        spinner.stop();

        if (opts.json) {
          out.json({
            id: res.id,
            type: outcomeType,
            campaignId,
            contactId,
          });
          return;
        }

        out.success(`Outcome logged: ${outcomeType}`);
        if (opts.notes) {
          out.info(`Notes: ${opts.notes}`);
        }
        navHint(["tap queue"]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });
}
