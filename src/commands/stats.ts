/**
 * Stats command for the TAP CLI.
 *
 * Shows workspace metrics: overview, warmth distribution, response rates,
 * top contacts, outcome distribution.
 */

import { Command } from "commander";
import chalk from "chalk";
import { getClient, resolveWorkspaceId } from "../auth.js";
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
          over_pitched: 0,
        };
        let totalResponseRate = 0;
        let totalAvgDays = 0;
        let avgDaysCount = 0;

        for (const m of metrics) {
          if (m.warmth_level && warmthDist[m.warmth_level] !== undefined) {
            warmthDist[m.warmth_level]++;
          }
          totalResponseRate += m.response_rate || 0;
          if (m.avg_response_days !== null) {
            totalAvgDays += m.avg_response_days;
            avgDaysCount++;
          }
        }

        const metricsTotal = metrics.length || 1;
        const avgResponseRate = totalResponseRate / metricsTotal;
        const avgResponseDays = avgDaysCount > 0 ? totalAvgDays / avgDaysCount : null;

        // Top contacts by response rate (min 3 pitches)
        const topContacts = metrics
          .filter((m) => m.total_pitches >= 3)
          .sort((a, b) => (b.response_rate || 0) - (a.response_rate || 0))
          .slice(0, 5);

        // Resolve top contact names
        let topContactDetails: Array<{
          name: string;
          outlet: string | null;
          response_rate: number;
          warmth_level: string | null;
        }> = [];

        if (topContacts.length > 0) {
          const contactIds = topContacts.map((m) => m.contact_id);
          const { data: contactData } = await supabase
            .from("tap_contacts")
            .select("id, name, outlet")
            .in("id", contactIds);

          const contactMap = new Map(
            (contactData || []).map((c) => [c.id, c]),
          );

          topContactDetails = topContacts.map((m) => {
            const contact = contactMap.get(m.contact_id);
            return {
              name: contact?.name || "Unknown",
              outlet: contact?.outlet || null,
              response_rate: m.response_rate || 0,
              warmth_level: m.warmth_level,
            };
          });
        }

        // Outcome distribution
        const outcomeDist: Record<string, number> = {};
        for (const o of outcomes) {
          outcomeDist[o.outcome_type] = (outcomeDist[o.outcome_type] || 0) + 1;
        }

        if (opts.json) {
          out.json({
            contacts: {
              total: totalContacts || 0,
              enriched: enrichedContacts || 0,
            },
            campaigns: {
              total: totalCampaigns || 0,
              active: activeCampaigns || 0,
            },
            outcomes: totalOutcomes || 0,
            pitches: totalPitches || 0,
            coverage: {
              total: totalCoverage || 0,
              last30Days: recentCoverage || 0,
            },
            warmthDistribution: warmthDist,
            avgResponseRate,
            avgResponseDays,
            topContacts: topContactDetails,
            outcomeDistribution: outcomeDist,
          });
          return;
        }

        // -- Overview --
        sectionHeader("TAP Workspace Stats");

        sectionHeader("Overview");
        const tc = totalContacts || 0;
        const ec = enrichedContacts || 0;
        const enrichRate = tc > 0 ? Math.round((ec / tc) * 100) : 0;
        console.log(
          `  ${"Contacts".padEnd(18)}${chalk.cyan(tc)} total, ${chalk.green(ec)} enriched (${enrichRate}%)`,
        );
        console.log(
          `  ${"Campaigns".padEnd(18)}${chalk.cyan(totalCampaigns || 0)} total, ${chalk.green(activeCampaigns || 0)} active`,
        );
        console.log(
          `  ${"Pitches".padEnd(18)}${chalk.cyan(totalPitches || 0)} drafts`,
        );
        console.log(
          `  ${"Outcomes".padEnd(18)}${chalk.cyan(totalOutcomes || 0)} logged`,
        );
        console.log(
          `  ${"Coverage".padEnd(18)}${chalk.cyan(totalCoverage || 0)} clips${recentCoverage ? ` (${recentCoverage} this month)` : ""}`,
        );

        // -- Warmth Distribution --
        if (metrics.length > 0) {
          sectionHeader("Warmth Distribution");
          const warmthOrder = ["hot", "warm", "neutral", "cold", "over_pitched"] as const;
          for (const level of warmthOrder) {
            const count = warmthDist[level];
            if (count === 0 && level === "over_pitched") continue;
            const ratio = count / metricsTotal;
            const pct = Math.round(ratio * 100);
            const badge = out.warmthBadge(level);
            console.log(
              `  ${ansiPadEnd(badge, 22)}${sparkbar(ratio)}  ${String(count).padStart(4)} (${pct}%)`,
            );
          }
        }

        // -- Response Rates --
        if (metrics.length > 0) {
          sectionHeader("Response Rates");
          console.log(
            `  ${"Overall".padEnd(18)}${percentage(avgResponseRate)}`,
          );
          if (avgResponseDays !== null) {
            console.log(
              `  ${"Avg response".padEnd(18)}${avgResponseDays.toFixed(1)} days`,
            );
          }
        }

        // -- Top Contacts --
        if (topContactDetails.length > 0) {
          sectionHeader("Top Contacts", "min 3 pitches");
          for (const c of topContactDetails) {
            console.log(
              `  ${(out.truncate(c.name, 18) || "").padEnd(18)}  ${(out.truncate(c.outlet, 16) || chalk.dim("\u2014")).padEnd(16)}  ${ansiPadEnd(percentage(c.response_rate) || "", 8)}  ${out.warmthBadge(c.warmth_level)}`,
            );
          }
        }

        // -- Outcome Distribution --
        if (Object.keys(outcomeDist).length > 0) {
          sectionHeader("Outcome Distribution");
          const sorted = Object.entries(outcomeDist).sort(([, a], [, b]) => b - a);
          for (const [type, count] of sorted) {
            const ratio = count / (totalOutcomes || 1);
            console.log(
              `  ${type.replace(/_/g, " ").padEnd(18)}${sparkbar(ratio)}  ${String(count).padStart(4)}`,
            );
          }
        }

        navHint([
          "tap queue",
          "tap campaigns list",
          "tap contacts list --warm",
        ]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });
}
