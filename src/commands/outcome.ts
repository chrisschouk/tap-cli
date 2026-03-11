/**
 * Outcome command -- log campaign outcomes from the terminal.
 *
 * Usage:
 *   tap outcome <campaign-id> <contact-id> <type>
 *   tap outcome <campaign-id> <contact-id> replied --notes "Loved it, wants exclusive"
 *   tap outcome <campaign-id> <contact-id> played --channel radio
 */

import { Command } from "commander";
import ora from "ora";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import {
  mapOutcomeToStatuses,
  VALID_OUTCOME_TYPES,
  type OutcomeType,
} from "../lib/outcome-mapping.js";

export function outcomeCommand(): Command {
  return new Command("outcome")
    .description("Log a campaign outcome for a contact")
    .argument("<campaign-id>", "Campaign ID")
    .argument("<contact-id>", "Contact ID")
    .argument("<type>", `Outcome type: ${VALID_OUTCOME_TYPES.join(", ")}`)
    .option("-n, --notes <text>", "Notes about the outcome")
    .option("-c, --channel <channel>", "Channel (radio, press, playlist, sync)")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (campaignId, contactId, type, opts) => {
      // Validate outcome type
      if (!VALID_OUTCOME_TYPES.includes(type as OutcomeType)) {
        out.error(`Invalid outcome type: "${type}"`);
        out.info(`Valid types: ${VALID_OUTCOME_TYPES.join(", ")}`);
        process.exit(1);
      }

      const spinner = ora("Logging outcome...").start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);
        const statuses = mapOutcomeToStatuses(type as OutcomeType);

        // Insert outcome record
        const { data: outcome, error: insertErr } = await supabase
          .from("tap_contact_outcomes")
          .insert({
            workspace_id: wsId,
            project_id: campaignId,
            contact_id: contactId,
            outcome_type: type,
            notes: opts.notes || null,
            channel: opts.channel || null,
          })
          .select("id")
          .single();

        if (insertErr) {
          spinner.stop();
          out.error(insertErr.message);
          process.exit(1);
        }

        // Update campaign_contacts pitch_status if applicable
        if (statuses.pitchStatus) {
          await supabase
            .from("campaign_contacts")
            .update({ pitch_status: statuses.pitchStatus })
            .eq("project_id", campaignId)
            .eq("contact_id", contactId);
        }

        // Update tap_contacts pipeline_status if applicable
        if (statuses.pipelineStatus) {
          await supabase
            .from("tap_contacts")
            .update({ pipeline_status: statuses.pipelineStatus })
            .eq("id", contactId);
        }

        spinner.stop();

        if (opts.json) {
          out.json({
            id: outcome.id,
            type,
            campaignId,
            contactId,
            statusUpdates: statuses,
          });
          return;
        }

        out.success(`Outcome logged: ${type}`);

        if (statuses.pitchStatus) {
          out.info(
            `Pitch status ${out.pitchStatusBadge(statuses.pitchStatus)}`,
          );
        }
        if (statuses.pipelineStatus) {
          out.info(`Pipeline ${statuses.pipelineStatus}`);
        }
        if (opts.notes) {
          out.info(`Notes: ${opts.notes}`);
        }
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });
}
