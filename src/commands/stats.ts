/**
 * Stats command for the TAP CLI.
 *
 * Shows workspace metrics: overview, warmth distribution, response rates,
 * top contacts, outcome distribution.
 */

import { Command } from "commander";
import chalk from "chalk";
import { getClient, resolveWorkspaceId, hasApiKey } from "../auth.js";
import * as out from "../output.js";
import { sectionHeader, sparkbar, percentage, navHint, ansiPadEnd } from "../ui/detail.js";
import { handleError } from "../ui/errors.js";
import { blank } from "../ui/format.js";

export function statsCommand(): Command {
  return new Command("stats")
    .description("Show workspace statistics")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const spinner = out.spinner("Loading stats...");

      try {
        if (hasApiKey()) {
          spinner.stop();
          out.error("Stats command is not supported in REST mode. For security and token scoping, use legacy configuration mode (SUPABASE_URL + SUPABASE_KEY) or view the analytics dashboards on the TAP web portal.");
          process.exit(1);
        }

        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        // 30 days ago for coverage
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const [
          { count: totalContacts },
          { count: enrichedContacts },
          { count: totalCampaigns },
          { count: activeCampaigns },
          { count: totalOutcomes },
          { count: totalPitches },
          { count: totalCoverage },
          { count: recentCoverage },
          metricsResult,
          outcomesResult,
        ] = await Promise.all([
          supabase
            .from("tap_contacts")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", wsId),
          supabase
            .from("tap_contacts")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", wsId)
            .not("enriched_at", "is", null),
          supabase
            .from("tap_projects")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", wsId),
          supabase
            .from("tap_projects")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", wsId)
            .eq("status", "active"),
          supabase
            .from("tap_contact_outcomes")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", wsId),
          supabase
            .from("campaign_pitch_drafts")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", wsId),
          supabase
            .from("coverage_clips")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", wsId),
          supabase
            .from("coverage_clips")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", wsId)
            .gte("publish_date", thirtyDaysAgo.toISOString()),
          // All relationship metrics for workspace
          supabase
            .from("contact_relationship_metrics")
            .select("contact_id, warmth_level, warmth_score, response_rate, total_pitches, positive_outcomes, avg_response_days")
            .eq("workspace_id", wsId),
          // Outcome distribution
          supabase
            .from("tap_contact_outcomes")
            .select("outcome_type")
            .eq("workspace_id", wsId),
        ]);

        spinner.stop();

        const metrics = metricsResult.data || [];
        const outcomes = outcomesResult.data || [];

        // Warmth distribution
        const warmthDist: Record<string, number> = {
          hot: 0,
          warm: 0,
          neutral: 0,
          cold: 0,
        };
        let responseRates: number[] = [];
        let avgDays: number[] = [];

        for (const m of metrics) {
          if (m.warmth_level && warmthDist[m.warmth_level] !== undefined) {
            warmthDist[m.warmth_level]++;
          }
          if (m.response_rate !== null) responseRates.push(m.response_rate);
          if (m.avg_response_days !== null) avgDays.push(m.avg_response_days);
        }

        // Calculations
        const avgResponse = responseRates.length > 0
          ? responseRates.reduce((a, b) => a + b, 0) / responseRates.length
          : 0;
        const avgResponseDays = avgDays.length > 0
          ? avgDays.reduce((a, b) => a + b, 0) / avgDays.length
          : 0;

        if (opts.json) {
          out.json({
            contacts: { total: totalContacts, enriched: enrichedContacts },
            campaigns: { total: totalCampaigns, active: activeCampaigns },
            outcomes: { total: totalOutcomes },
            pitches: { total: totalPitches },
            coverage: { total: totalCoverage, recent30d: recentCoverage },
            metrics: { avgResponse, avgResponseDays, warmth: warmthDist },
          });
          return;
        }

        // Print Stats Overview
        console.log("");
        console.log(chalk.bold("  Workspace Overview"));
        console.log(chalk.dim("  " + "\u2500".repeat(52)));

        console.log(`  ${chalk.dim("Contacts")}        ${totalContacts} (${percentage((enrichedContacts || 0) / (totalContacts || 1))} enriched)`);
        console.log(`  ${chalk.dim("Campaigns")}       ${totalCampaigns} (${activeCampaigns} active)`);
        console.log(`  ${chalk.dim("Outcomes logged")} ${totalOutcomes}`);
        console.log(`  ${chalk.dim("Coverage clips")}  ${totalCoverage} (${recentCoverage} in last 30 days)`);

        // Warmth
        sectionHeader("Warmth Distribution");
        const totalWithWarmth = Object.values(warmthDist).reduce((a, b) => a + b, 0);
        for (const [level, count] of Object.entries(warmthDist)) {
          const ratio = totalWithWarmth > 0 ? count / totalWithWarmth : 0;
          console.log(`  ${ansiPadEnd(out.warmthBadge(level), 18)}${sparkbar(ratio)}  ${String(count).padStart(4)}`);
        }

        // Engagement
        sectionHeader("Engagement Metrics");
        console.log(`  ${chalk.dim("Avg reply rate")}   ${percentage(avgResponse)}`);
        console.log(`  ${chalk.dim("Avg reply time")}   ${avgResponseDays > 0 ? avgResponseDays.toFixed(1) + " days" : "—"}`);

        // Outcomes
        if (outcomes.length > 0) {
          sectionHeader("Outcomes Breakdown");
          const outcomeDist: Record<string, number> = {};
          for (const o of outcomes) {
            outcomeDist[o.outcome_type] = (outcomeDist[o.outcome_type] || 0) + 1;
          }
          const sorted = Object.entries(outcomeDist).sort(([, a], [, b]) => b - a);
          for (const [type, count] of sorted) {
            const ratio = count / outcomes.length;
            console.log(`  ${ansiPadEnd(type.replace(/_/g, " "), 18)}${sparkbar(ratio)}  ${String(count).padStart(4)}`);
          }
        }

        navHint(["tap campaigns list", "tap contacts list"]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });
}
