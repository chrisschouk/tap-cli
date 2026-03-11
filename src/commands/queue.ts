/**
 * Action queue command for the TAP CLI.
 *
 * Shows prioritised daily actions: follow-ups, unpitched, enrichment, embargoed.
 */

import { Command } from "commander";
import chalk from "chalk";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import { GLYPH } from "../ui/theme.js";
import { relativeDate } from "../ui/detail.js";

export function queueCommand(): Command {
  return new Command("queue")
    .description("Show today's action queue")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const spinner = out.spinner("Loading action queue...").start();

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
            // Follow-ups: pitched > 3 days ago, no reply -- with contact names
            supabase
              .from("campaign_contacts")
              .select("contact_id, project_id, last_pitched_at")
              .in("project_id", campaignIds)
              .eq("pitch_status", "sent")
              .lt("last_pitched_at", threeDaysAgo.toISOString())
              .order("last_pitched_at", { ascending: true })
              .limit(20),

            // Unenriched contacts
            supabase
              .from("tap_contacts")
              .select("id", { count: "exact", head: true })
              .eq("workspace_id", wsId)
              .is("enriched_at", null),

            // Unpitched contacts in active campaigns
            supabase
              .from("campaign_contacts")
              .select("contact_id", { count: "exact", head: true })
              .in("project_id", campaignIds)
              .eq("pitch_status", "not_pitched"),

            // Embargoed/cooling contacts
            supabase
              .from("tap_contacts")
              .select("id, name, outlet, pitch_embargo_until, cooling_off")
              .eq("workspace_id", wsId)
              .or("cooling_off.eq.true,pitch_embargo_until.gt." + new Date().toISOString())
              .limit(10),
          ]);

        // Resolve contact names and warmth for follow-ups
        const followUps = followUpResult.data || [];
        let followUpDetails: Array<{
          contactName: string;
          outlet: string | null;
          warmth: string | null;
          campaignName: string;
          lastPitched: string | null;
        }> = [];

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
              contactName: contact?.name || f.contact_id.slice(0, 8),
              outlet: contact?.outlet || null,
              warmth: warmthMap.get(f.contact_id) || null,
              campaignName: campaign
                ? campaign.artist_name
                  ? `${campaign.artist_name} -- ${campaign.name}`
                  : campaign.name
                : "Unknown",
              lastPitched: f.last_pitched_at,
            };
          });
        }

        const embargoed = embargoedResult.data || [];

        spinner.stop();

        if (opts.json) {
          out.json({
            followUps: followUpDetails,
            unpitchedCount: unpitchedResult.count || 0,
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
        console.log(chalk.dim(`  ${GLYPH.divider.repeat(44)}`));

        // Follow-ups (HIGH)
        if (followUpDetails.length > 0) {
          console.log("");
          console.log(
            `  ${chalk.bold("Follow-ups Needed")} (${followUpDetails.length})${" ".repeat(Math.max(1, 24 - String(followUpDetails.length).length))}${chalk.red.bold("HIGH")}`,
          );
          console.log(chalk.dim(`  ${GLYPH.divider.repeat(44)}`));

          for (const f of followUpDetails) {
            const warmthStr = f.warmth
              ? out.warmthBadge(f.warmth)
              : chalk.dim("--");
            console.log(
              `  ${chalk.dim(GLYPH.dot)} ${chalk.bold(f.contactName)}${f.outlet ? chalk.dim(` -- ${f.outlet}`) : ""}  ${warmthStr}  ${relativeDate(f.lastPitched)}`,
            );
            console.log(`    ${chalk.dim(f.campaignName)}`);
          }
        }

        // Unpitched (MEDIUM)
        const unpitchedCount = unpitchedResult.count || 0;
        if (unpitchedCount > 0) {
          console.log("");
          console.log(
            `  ${chalk.bold("Unpitched")} (${unpitchedCount})${" ".repeat(Math.max(1, 32 - String(unpitchedCount).length))}${chalk.yellow.bold("MEDIUM")}`,
          );
          console.log(chalk.dim(`  ${GLYPH.divider.repeat(44)}`));

          // Fetch warmth for unpitched contacts
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

        // Enrichment (LOW)
        const unenrichedCount = unenrichedResult.count || 0;
        if (unenrichedCount > 0) {
          console.log("");
          console.log(
            `  ${chalk.bold("Enrichment")} (${unenrichedCount})${" ".repeat(Math.max(1, 31 - String(unenrichedCount).length))}${chalk.dim("LOW")}`,
          );
          console.log(chalk.dim(`  ${GLYPH.divider.repeat(44)}`));
          console.log(`  ${unenrichedCount} contacts need enrichment`);
        }

        // Embargoed
        if (embargoed.length > 0) {
          console.log("");
          console.log(`  ${chalk.bold("Embargoed")} (${embargoed.length})`);
          console.log(chalk.dim(`  ${GLYPH.divider.repeat(44)}`));

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

        console.log("");
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });
}
