/**
 * Action queue command for the TAP CLI.
 *
 * Shows prioritised daily actions: follow-ups, unpitched, enrichment, embargoed.
 * In TTY mode, items are selectable with inline actions.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import { GLYPH } from "../ui/theme.js";
import { relativeDate, navHint, campaignLabel } from "../ui/detail.js";
import { runCommand } from "../ui/run-command.js";
import { handleError } from "../ui/errors.js";
import { blank } from "../ui/format.js";
import { outcomePrompt, contactActionMenu } from "../ui/actions.js";

export function queueCommand(): Command {
  return new Command("queue")
    .description("Show today's action queue")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const spinner = out.spinner("Loading action queue...");

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        // Active campaigns
        const { data: campaigns } = await supabase
          .from("tap_projects")
          .select("id, name, artist_name")
          .eq("workspace_id", wsId)
          .eq("status", "active");

        if (!campaigns || campaigns.length === 0) {
          spinner.stop();
          out.info("No active campaigns. Nothing in the queue.");
          return;
        }

        const campaignIds = campaigns.map((c) => c.id);
        const campaignMap = new Map(campaigns.map((c) => [c.id, c]));

        // Parallel queries
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

        const [followUpResult, unenrichedResult, unpitchedResult, embargoedResult] =
          await Promise.all([
            supabase
              .from("campaign_contacts")
              .select("contact_id, project_id, last_pitched_at")
              .in("project_id", campaignIds)
              .eq("pitch_status", "sent")
              .lt("last_pitched_at", threeDaysAgo.toISOString())
              .order("last_pitched_at", { ascending: true })
              .limit(20),

            supabase
              .from("tap_contacts")
              .select("id", { count: "exact", head: true })
              .eq("workspace_id", wsId)
              .is("enriched_at", null),

            supabase
              .from("campaign_contacts")
              .select("contact_id, project_id", { count: "exact" })
              .in("project_id", campaignIds)
              .eq("pitch_status", "not_pitched")
              .limit(10),

            supabase
              .from("tap_contacts")
              .select("id, name, outlet, pitch_embargo_until, cooling_off")
              .eq("workspace_id", wsId)
              .or("cooling_off.eq.true,pitch_embargo_until.gt." + new Date().toISOString())
              .limit(10),
          ]);

        // Resolve contact names and warmth for follow-ups
        const followUps = followUpResult.data || [];
        interface FollowUpDetail {
          contactId: string;
          contactName: string;
          outlet: string | null;
          warmth: string | null;
          campaignId: string;
          campaignName: string;
          lastPitched: string | null;
        }

        let followUpDetails: FollowUpDetail[] = [];

        if (followUps.length > 0) {
          const contactIds = [...new Set(followUps.map((f) => f.contact_id))];

          const [contactResult, metricsResult] = await Promise.all([
            supabase
              .from("tap_contacts")
              .select("id, name, outlet")
              .in("id", contactIds),
            supabase
              .from("contact_relationship_metrics")
              .select("contact_id, warmth_level")
              .in("contact_id", contactIds),
          ]);

          const contactMap = new Map(
            (contactResult.data || []).map((c) => [c.id, c]),
          );
          const warmthMap = new Map(
            (metricsResult.data || []).map((m) => [m.contact_id, m.warmth_level]),
          );

          followUpDetails = followUps.map((f) => {
            const contact = contactMap.get(f.contact_id);
            const campaign = campaignMap.get(f.project_id);
            return {
              contactId: f.contact_id,
              contactName: contact?.name || f.contact_id.slice(0, 8),
              outlet: contact?.outlet || null,
              warmth: warmthMap.get(f.contact_id) || null,
              campaignId: f.project_id,
              campaignName: campaign ? campaignLabel(campaign) : "Unknown",
              lastPitched: f.last_pitched_at,
            };
          });
        }

        // Resolve unpitched contact details for interactive mode
        const unpitchedData = unpitchedResult.data || [];
        const unpitchedCount = unpitchedResult.count || 0;
        interface UnpitchedDetail {
          contactId: string;
          contactName: string;
          outlet: string | null;
          warmth: string | null;
          campaignId: string;
          campaignName: string;
        }

        let unpitchedDetails: UnpitchedDetail[] = [];

        if (unpitchedData.length > 0 && process.stdout.isTTY) {
          const unpitchedIds = [...new Set(unpitchedData.map((c) => c.contact_id))];
          const [contactResult, metricsResult] = await Promise.all([
            supabase
              .from("tap_contacts")
              .select("id, name, outlet")
              .in("id", unpitchedIds),
            supabase
              .from("contact_relationship_metrics")
              .select("contact_id, warmth_level, warmth_score")
              .in("contact_id", unpitchedIds),
          ]);

          const contactMap = new Map(
            (contactResult.data || []).map((c) => [c.id, c]),
          );
          const metricsMap = new Map(
            (metricsResult.data || []).map((m) => [m.contact_id, m]),
          );

          // Build details with warmth for sorting
          const rawDetails = unpitchedData.map((u) => {
            const contact = contactMap.get(u.contact_id);
            const metrics = metricsMap.get(u.contact_id);
            const campaign = campaignMap.get(u.project_id);
            return {
              contactId: u.contact_id,
              contactName: contact?.name || u.contact_id.slice(0, 8),
              outlet: contact?.outlet || null,
              warmth: metrics?.warmth_level || null,
              warmthScore: metrics?.warmth_score || 0,
              campaignId: u.project_id,
              campaignName: campaign ? campaignLabel(campaign) : "Unknown",
            };
          });

          // Sort hot-first, deduplicate by contactId
          rawDetails.sort((a, b) => (b.warmthScore || 0) - (a.warmthScore || 0));
          const seen = new Set<string>();
          unpitchedDetails = rawDetails.filter((d) => {
            if (seen.has(d.contactId)) return false;
            seen.add(d.contactId);
            return true;
          });
        }

        const embargoed = embargoedResult.data || [];

        spinner.stop();

        if (opts.json) {
          out.json({
            followUps: followUpDetails,
            unpitchedCount,
            unenrichedCount: unenrichedResult.count || 0,
            embargoedCount: embargoed.length,
            activeCampaigns: campaigns.length,
          });
          return;
        }

        // Header
        console.log("");
        console.log(
          `  ${chalk.bold("Action Queue")} ${chalk.dim(GLYPH.divider + GLYPH.divider)} ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`,
        );
        console.log(
          `  ${chalk.dim(`${campaigns.length} active campaign${campaigns.length === 1 ? "" : "s"}`)}`,
        );
        console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));

        // Follow-ups (HIGH)
        if (followUpDetails.length > 0) {
          console.log("");
          console.log(
            `  ${chalk.bold("Follow-ups Needed")} (${followUpDetails.length})${" ".repeat(Math.max(1, 24 - String(followUpDetails.length).length))}${chalk.red.bold("HIGH")}`,
          );
          console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));

          for (const f of followUpDetails) {
            const warmthStr = f.warmth
              ? out.warmthBadge(f.warmth)
              : chalk.dim("--");
            console.log(
              `  ${chalk.dim(GLYPH.dot)} ${chalk.bold(f.contactName)}${f.outlet ? chalk.dim(` -- ${f.outlet}`) : ""}  ${warmthStr}  ${relativeDate(f.lastPitched)}`,
            );
            console.log(`    ${chalk.dim(f.campaignName)}`);
          }

          // Interactive follow-up selection (TTY only)
          if (process.stdout.isTTY) {
            blank();
            const selected = await prompts.select({
              message: "Act on a follow-up?",
              options: [
                ...followUpDetails.map((f) => ({
                  value: f.contactId as string,
                  label: f.contactName,
                  hint: `${f.campaignName} ${GLYPH.dot} ${relativeDate(f.lastPitched)}`,
                })),
                { value: "__skip__" as string, label: chalk.dim("Skip") },
              ],
            });

            if (!prompts.isCancel(selected) && selected !== "__skip__") {
              const fu = followUpDetails.find((f) => f.contactId === selected)!;

              const action = await prompts.select({
                message: `${fu.contactName}`,
                options: [
                  { value: "follow_up" as const, label: "Generate follow-up pitch" },
                  { value: "outcome" as const, label: "Log outcome" },
                  { value: "view" as const, label: "View contact" },
                  { value: "back" as const, label: chalk.dim("Back") },
                ],
              });

              if (!prompts.isCancel(action)) {
                if (action === "follow_up") {
                  await runCommand(["pitch", fu.campaignId, fu.contactId]);
                } else if (action === "outcome") {
                  blank();
                  await outcomePrompt(supabase, wsId, fu.campaignId, fu.contactId);
                } else if (action === "view") {
                  blank();
                  const { showContact } = await import("./contacts.js");
                  await showContact(fu.contactId, {});
                  await contactActionMenu(supabase, wsId, fu.contactId, { campaignId: fu.campaignId });
                }
              }
            }
          }
        }

        // Unpitched (MEDIUM)
        if (unpitchedCount > 0) {
          console.log("");
          console.log(
            `  ${chalk.bold("Unpitched")} (${unpitchedCount})${" ".repeat(Math.max(1, 32 - String(unpitchedCount).length))}${chalk.yellow.bold("MEDIUM")}`,
          );
          console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));

          if (unpitchedDetails.length > 0 && process.stdout.isTTY) {
            // Show top contacts sorted hot-first
            for (const u of unpitchedDetails.slice(0, 5)) {
              const warmthStr = u.warmth
                ? out.warmthBadge(u.warmth)
                : chalk.dim("--");
              console.log(
                `  ${chalk.dim(GLYPH.dot)} ${u.contactName}${u.outlet ? chalk.dim(` -- ${u.outlet}`) : ""}  ${warmthStr}`,
              );
            }
            if (unpitchedCount > 5) {
              console.log(chalk.dim(`  +${unpitchedCount - 5} more`));
            }

            // Interactive unpitched selection
            blank();
            const selected = await prompts.select({
              message: "Pitch a contact?",
              options: [
                ...unpitchedDetails.slice(0, 10).map((u) => ({
                  value: u.contactId as string,
                  label: u.contactName,
                  hint: [u.outlet, u.warmth].filter(Boolean).join(` ${chalk.dim(GLYPH.dot)} `) || undefined,
                })),
                { value: "__skip__" as string, label: chalk.dim("Skip") },
              ],
            });

            if (!prompts.isCancel(selected) && selected !== "__skip__") {
              const u = unpitchedDetails.find((d) => d.contactId === selected)!;
              await runCommand(["pitch", u.campaignId, u.contactId]);
            }
          } else {
            // Non-TTY or no detail data -- show summary with warmth hint
            const { data: unpitchedContacts } = await supabase
              .from("campaign_contacts")
              .select("contact_id")
              .in("project_id", campaignIds)
              .eq("pitch_status", "not_pitched")
              .limit(500);

            let warmthHint = "";
            if (unpitchedContacts && unpitchedContacts.length > 0) {
              const unpitchedIds = [...new Set(unpitchedContacts.map((c) => c.contact_id))];
              const { data: unpitchedMetrics } = await supabase
                .from("contact_relationship_metrics")
                .select("contact_id, warmth_level")
                .in("contact_id", unpitchedIds);

              if (unpitchedMetrics && unpitchedMetrics.length > 0) {
                const hotCount = unpitchedMetrics.filter((m) => m.warmth_level === "hot").length;
                const warmCount = unpitchedMetrics.filter((m) => m.warmth_level === "warm").length;
                const parts: string[] = [];
                if (hotCount) parts.push(chalk.hex("#ef4444")(`${hotCount} hot`));
                if (warmCount) parts.push(chalk.hex("#f97316")(`${warmCount} warm`));
                if (parts.length > 0) {
                  warmthHint = ` (${parts.join(", ")} ${chalk.dim("-- pitch these first")})`;
                }
              }
            }

            console.log(
              `  ${unpitchedCount} unpitched across ${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}${warmthHint}`,
            );
          }
        }

        // Enrichment (LOW)
        const unenrichedCount = unenrichedResult.count || 0;
        if (unenrichedCount > 0) {
          console.log("");
          console.log(
            `  ${chalk.bold("Enrichment")} (${unenrichedCount})${" ".repeat(Math.max(1, 31 - String(unenrichedCount).length))}${chalk.dim("LOW")}`,
          );
          console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));
          console.log(`  ${unenrichedCount} contacts need enrichment`);

          // Batch enrich action (TTY only)
          if (process.stdout.isTTY && unenrichedCount > 0) {
            blank();
            const shouldEnrich = await prompts.confirm({
              message: `Queue all ${unenrichedCount} for enrichment?`,
              initialValue: false,
            });

            if (!prompts.isCancel(shouldEnrich) && shouldEnrich) {
              const enrichSpinner = out.spinner("Queueing enrichment...");
              const { error } = await supabase
                .from("tap_contacts")
                .update({ enrichment_source: "queued" })
                .eq("workspace_id", wsId)
                .is("enriched_at", null);
              enrichSpinner.stop();

              if (error) {
                out.error(error.message);
              } else {
                out.success(`${unenrichedCount} contacts queued for enrichment`);
              }
            }
          }
        }

        // Embargoed
        if (embargoed.length > 0) {
          console.log("");
          console.log(`  ${chalk.bold("Embargoed")} (${embargoed.length})`);
          console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));

          for (const c of embargoed) {
            if (c.pitch_embargo_until) {
              const until = new Date(c.pitch_embargo_until).toLocaleDateString(
                "en-GB",
                { day: "numeric", month: "short" },
              );
              console.log(
                `  ${chalk.dim(GLYPH.dot)} ${c.name || "Unknown"} ${chalk.dim(`-- embargo until ${until}`)}`,
              );
            } else if (c.cooling_off) {
              console.log(
                `  ${chalk.dim(GLYPH.dot)} ${c.name || "Unknown"} ${chalk.dim("-- cooling off")}`,
              );
            }
          }
        }

        // All clear
        if (
          followUpDetails.length === 0 &&
          unpitchedCount === 0 &&
          unenrichedCount === 0 &&
          embargoed.length === 0
        ) {
          out.success("Queue is clear. Nice work.");
        }

        navHint([
          "tap contacts show <id>",
          "tap send <pitch-id>",
        ]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });
}
