/**
 * Outcome command -- log campaign outcomes from the terminal.
 *
 * Usage:
 *   tap outcome <campaign-id> <contact-id> <type>
 *   tap outcome <campaign-id> <contact-id> replied --notes "Loved it, wants exclusive"
 *   tap outcome <campaign-id> <contact-id> played --channel radio
 */

import { Command } from "commander";
import { getClient, resolveWorkspaceId, hasApiKey } from "../auth.js";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import { handleError } from "../ui/errors.js";
import { navHint } from "../ui/detail.js";
import { blank } from "../ui/format.js";
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
    .option("--dry-run", "Preview without saving")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  tap outcome abc123 def456 replied --notes "Loved it, wants exclusive"
  tap outcome abc123 def456 played --channel radio
  tap outcome abc123 def456 declined --dry-run`)
    .action(async (campaignId, contactId, type, opts) => {
      // Validate outcome type
      if (!VALID_OUTCOME_TYPES.includes(type as OutcomeType)) {
        out.error(`Invalid outcome type: "${type}"`);
        out.info(`Valid types: ${VALID_OUTCOME_TYPES.join(", ")}`);
        process.exit(1);
      }

      const spinner = out.spinner("Logging outcome...");

      try {
        if (hasApiKey()) {
          if (opts.dryRun) {
            spinner.stop();
            out.info(`Dry run -- would log "${type}" for contact ${contactId} in campaign ${campaignId}`);
            if (opts.notes) out.info(`Notes: ${opts.notes}`);
            return;
          }

          const res = await restRequest<{ id: string }>("/api/v1/outcomes", {
            method: "POST",
            body: {
              campaign_id: campaignId,
              contact_id: contactId,
              outcome_type: type,
              notes: opts.notes || undefined,
              channel: opts.channel || undefined,
            },
          });

          spinner.stop();

          if (opts.json) {
            out.json({
              id: res.id,
              type,
              campaignId,
              contactId,
            });
            return;
          }

          out.success(`Outcome logged: ${type}`);
          if (opts.notes) {
            out.info(`Notes: ${opts.notes}`);
          }
          navHint(["tap queue"]);
          blank();
          return;
        }

        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);
        const statuses = mapOutcomeToStatuses(type as OutcomeType);

        if (opts.dryRun) {
          spinner.stop();
          out.info(`Dry run -- would log "${type}" for contact ${contactId} in campaign ${campaignId}`);
          if (statuses.pitchStatus) out.info(`Would set pitch status: ${statuses.pitchStatus}`);
          if (statuses.pipelineStatus) out.info(`Would set pipeline status: ${statuses.pipelineStatus}`);
          if (opts.notes) out.info(`Notes: ${opts.notes}`);
          return;
        }

        // Verify campaign-contact relationship exists
        const { data: ccRow } = await supabase
          .from("campaign_contacts")
          .select("id")
          .eq("project_id", campaignId)
          .eq("contact_id", contactId)
          .maybeSingle();

        if (!ccRow) {
          spinner.stop();
          out.error("Contact is not part of this campaign. Add them first.");
          process.exit(1);
        }

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

        // Update statuses in parallel
        const updates: PromiseLike<unknown>[] = [];
        if (statuses.pitchStatus) {
          updates.push(
            supabase
              .from("campaign_contacts")
              .update({ pitch_status: statuses.pitchStatus })
              .eq("project_id", campaignId)
              .eq("contact_id", contactId),
          );
        }
        if (statuses.pipelineStatus) {
          updates.push(
            supabase
              .from("tap_contacts")
              .update({ pipeline_status: statuses.pipelineStatus })
              .eq("id", contactId),
          );
        }
        if (updates.length > 0) await Promise.all(updates);

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
        navHint(["tap queue", "tap contacts history <id>"]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });
}
