/**
 * Campaign commands for the TAP CLI.
 */

import { Command } from "commander";
import chalk from "chalk";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import { GLYPH, COLOUR } from "../ui/theme.js";
import { sectionHeader, sparkbar, shortDate, navHint } from "../ui/detail.js";

/**
 * Show full campaign detail view with health metrics and coverage.
 * Exported so interactive mode can call it directly.
 */
export async function showCampaign(
  id: string,
  opts: { workspace?: string; json?: boolean },
): Promise<void> {
  const spinner = out.spinner("Loading campaign...");

  try {
    const supabase = getClient();

    // Fetch campaign + contacts + outcomes + coverage in parallel
    const [campResult, contactsResult] = await Promise.all([
      supabase
        .from("tap_projects")
        .select(
          "id, name, artist_name, status, release_name, release_date, goal, created_at, momentum_score, momentum_trend",
        )
        .eq("id", id)
        .single(),
      supabase
        .from("campaign_contacts")
        .select("pitch_status, last_pitched_at, contact_id")
        .eq("project_id", id),
    ]);

    if (campResult.error || !campResult.data) {
      spinner.stop();
      out.error(campResult.error?.message || `Campaign not found: ${id}`);
      process.exit(1);
    }

    const campaign = campResult.data;
    const contacts = contactsResult.data || [];
    const contactIds = contacts.map((c) => c.contact_id);

    // Batch helper for large IN queries (Supabase URL limit ~8000 chars)
    async function batchIn<T>(
      table: string,
      select: string,
      column: string,
      ids: string[],
      chunkSize = 200,
    ): Promise<T[]> {
      if (ids.length === 0) return [];
      const results: T[] = [];
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const { data } = await supabase
          .from(table)
          .select(select)
          .in(column, chunk);
        if (data) results.push(...(data as T[]));
      }
      return results;
    }

    // Second wave: outcomes, coverage, metrics, names (need contact IDs)
    const [outcomesResult, coverageResult, metricsData, contactNames] =
      await Promise.all([
        supabase
          .from("tap_contact_outcomes")
          .select("outcome_type")
          .eq("project_id", id),
        supabase
          .from("coverage_clips")
          .select("id, title, type, url, publish_date, status")
          .eq("campaign_id", id)
          .order("publish_date", { ascending: false })
          .limit(10),
        batchIn<{ contact_id: string; warmth_level: string | null; response_rate: number; avg_response_days: number | null }>(
          "contact_relationship_metrics", "contact_id, warmth_level, response_rate, avg_response_days", "contact_id", contactIds,
        ),
        batchIn<{ id: string; name: string | null; outlet: string | null }>(
          "tap_contacts", "id, name, outlet", "id", contactIds,
        ),
      ]);

    spinner.stop();

    const outcomes = outcomesResult.data || [];
    const coverageClips = coverageResult.data || [];

    if (opts.json) {
      out.json({ campaign, contacts, outcomes, coverage: coverageClips, metrics: metricsData });
      return;
    }

    // -- Header --
    console.log("");
    console.log(
      `  ${chalk.bold(campaign.name)}  ${out.statusBadge(campaign.status)}`,
    );
    if (campaign.artist_name) {
      console.log(`  ${chalk.dim("Artist")}  ${campaign.artist_name}`);
    }
    if (campaign.release_name) {
      console.log(`  ${chalk.dim("Release")} ${campaign.release_name}`);
    }
    if (campaign.release_date) {
      const d = new Date(campaign.release_date).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      console.log(`  ${chalk.dim("Date")}    ${d}`);
    }
    if (campaign.goal) {
      console.log(`  ${chalk.dim("Goal")}    ${campaign.goal}`);
    }

    // -- Contact table --
    if (contacts.length > 0) {
      const contactMap = new Map(contactNames.map((c) => [c.id, c]));

      const rows = contacts
        .map((c) => {
          const contact = contactMap.get(c.contact_id);
          return [
            out.truncate(contact?.name || c.contact_id.slice(0, 8), 22),
            out.truncate(contact?.outlet, 16) || "\u2014",
            out.pitchStatusBadge(c.pitch_status),
            shortDate(c.last_pitched_at),
          ];
        });

      console.log("");
      out.table(["Name", "Outlet", "Pitch Status", "Last Pitched"], rows);
    }

    // -- Health --
    const total = contacts.length;
    const pitched = contacts.filter(
      (c) => c.pitch_status && c.pitch_status !== "not_pitched",
    ).length;
    const replied = contacts.filter(
      (c) => c.pitch_status === "replied",
    ).length;

    const pctPitched = total > 0 ? Math.round((pitched / total) * 100) : 0;
    const pctReplied = pitched > 0 ? Math.round((replied / pitched) * 100) : 0;

    // Warmth breakdown
    const warmthCounts: Record<string, number> = { hot: 0, warm: 0, neutral: 0, cold: 0 };
    let totalAvgDays = 0;
    let avgDaysCount = 0;

    for (const m of metricsData) {
      if (m.warmth_level && warmthCounts[m.warmth_level] !== undefined) {
        warmthCounts[m.warmth_level]++;
      }
      if (m.avg_response_days !== null) {
        totalAvgDays += m.avg_response_days;
        avgDaysCount++;
      }
    }

    sectionHeader("Health");
    console.log(
      `  ${chalk.dim("Contacts")} ${total}  ${chalk.dim(GLYPH.dot)}  ` +
        `${chalk.dim("Pitched")} ${chalk.hex(COLOUR.primary)(`${pctPitched}%`)}  ${chalk.dim(GLYPH.dot)}  ` +
        `${chalk.dim("Reply rate")} ${chalk.hex(COLOUR.success)(`${pctReplied}%`)}`,
    );
    if (metricsData.length > 0) {
      const warmthParts = Object.entries(warmthCounts)
        .filter(([, count]) => count > 0)
        .map(([level, count]) => `${count} ${out.warmthBadge(level)}`);
      if (warmthParts.length > 0) {
        console.log(`  ${chalk.dim("Warmth")}   ${warmthParts.join(` ${chalk.dim(GLYPH.dot)} `)}`);
      }
      if (avgDaysCount > 0) {
        console.log(
          `  ${chalk.dim("Avg response")} ${(totalAvgDays / avgDaysCount).toFixed(1)} days`,
        );
      }
    }

    // -- Pitch Funnel --
    const statusCounts: Record<string, number> = {};
    for (const c of contacts) {
      const status = c.pitch_status || "not_pitched";
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }

    if (Object.keys(statusCounts).length > 0) {
      sectionHeader("Pitch Funnel");
      const funnelOrder = ["not_pitched", "sent", "replied", "declined", "bounced"];
      for (const status of funnelOrder) {
        const count = statusCounts[status];
        if (!count) continue;
        const ratio = count / total;
        console.log(
          `  ${out.pitchStatusBadge(status)?.padEnd(16)}${sparkbar(ratio)}  ${String(count).padStart(4)}`,
        );
      }
      // Any other statuses
      for (const [status, count] of Object.entries(statusCounts)) {
        if (funnelOrder.includes(status)) continue;
        const ratio = count / total;
        console.log(
          `  ${out.pitchStatusBadge(status)?.padEnd(16)}${sparkbar(ratio)}  ${String(count).padStart(4)}`,
        );
      }
    }

    // -- Coverage --
    if (coverageClips.length > 0) {
      sectionHeader("Coverage", `${coverageClips.length}`);
      for (const clip of coverageClips) {
        console.log(
          `  ${out.truncate(clip.title, 34)?.padEnd(34)}  ${chalk.dim(clip.type?.padEnd(12) || "")}  ${shortDate(clip.publish_date)}`,
        );
        if (clip.url) {
          console.log(`    ${chalk.dim(clip.url)}`);
        }
      }
    }

    // -- Outcome Distribution --
    if (outcomes.length > 0) {
      const outcomeDist: Record<string, number> = {};
      for (const o of outcomes) {
        outcomeDist[o.outcome_type] = (outcomeDist[o.outcome_type] || 0) + 1;
      }
      sectionHeader("Outcomes", `${outcomes.length}`);
      const sorted = Object.entries(outcomeDist).sort(([, a], [, b]) => b - a);
      for (const [type, count] of sorted) {
        const ratio = count / outcomes.length;
        console.log(
          `  ${type.replace(/_/g, " ").padEnd(18)}${sparkbar(ratio)}  ${String(count).padStart(4)}`,
        );
      }
    }

    navHint([`tap open ${id.slice(0, 8)}`]);
    console.log("");
  } catch (err) {
    spinner.stop();
    out.error(err instanceof Error ? err.message : "Unknown error");
    process.exit(1);
  }
}

export function campaignsCommand(): Command {
  const cmd = new Command("campaigns").description("Manage campaigns");

  cmd
    .command("list")
    .description("List campaigns")
    .option(
      "-s, --status <status>",
      "Filter by status (draft, active, completed, archived)",
    )
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const spinner = out.spinner("Fetching campaigns...");

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        let query = supabase
          .from("tap_projects")
          .select(
            "id, name, artist_name, status, release_name, release_date, created_at",
          )
          .eq("workspace_id", wsId)
          .order("created_at", { ascending: false })
          .limit(50);

        if (opts.status) query = query.eq("status", opts.status);

        const { data, error } = await query;
        spinner.stop();

        if (error) {
          out.error(error.message);
          process.exit(1);
        }

        if (opts.json) {
          out.json(data);
          return;
        }

        if (!data || data.length === 0) {
          out.info("No campaigns found");
          return;
        }

        out.table(
          ["Name", "Artist", "Status", "Release", "Created"],
          data.map((c) => [
            out.truncate(c.name, 30),
            out.truncate(c.artist_name, 20) || "\u2014",
            out.statusBadge(c.status),
            c.release_date || "\u2014",
            new Date(c.created_at).toLocaleDateString("en-GB"),
          ]),
        );

        out.info(`${data.length} campaigns`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });

  cmd
    .command("show")
    .description("Show campaign details with health metrics and coverage")
    .argument("<id>", "Campaign ID")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
      await showCampaign(id, opts);
    });

  cmd
    .command("create")
    .description("Create a new campaign")
    .requiredOption("-n, --name <name>", "Campaign name")
    .option("-a, --artist <name>", "Artist name")
    .option("-r, --release <name>", "Release name")
    .option("-d, --date <date>", "Release date (YYYY-MM-DD)")
    .option(
      "-c, --channels <channels>",
      "Channels (comma-separated: radio,press,playlist)",
    )
    .option("-w, --workspace <id>", "Workspace ID")
    .action(async (opts) => {
      const spinner = out.spinner("Creating campaign...");

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        const { data, error } = await supabase
          .from("tap_projects")
          .insert({
            workspace_id: wsId,
            name: opts.name,
            artist_name: opts.artist || null,
            release_name: opts.release || null,
            release_date: opts.date || null,
            services: opts.channels ? opts.channels.split(",") : null,
            status: "draft",
          })
          .select("id, name")
          .single();

        spinner.stop();

        if (error) {
          out.error(error.message);
          process.exit(1);
        }

        out.success(`Campaign "${data.name}" created (${data.id})`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });

  cmd
    .command("status")
    .description("Change campaign status")
    .argument("<id>", "Campaign ID")
    .argument(
      "<status>",
      "New status (draft, active, paused, completed, archived)",
    )
    .action(async (id, status) => {
      const validStatuses = [
        "draft",
        "active",
        "paused",
        "completed",
        "archived",
      ];
      if (!validStatuses.includes(status)) {
        out.error(
          `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        );
        process.exit(1);
      }

      const spinner = out.spinner("Updating status...");

      try {
        const supabase = getClient();

        const { data, error } = await supabase
          .from("tap_projects")
          .update({ status })
          .eq("id", id)
          .select("id");

        spinner.stop();

        if (error) {
          out.error(error.message);
          process.exit(1);
        }

        if (!data || data.length === 0) {
          out.error(`Campaign not found: ${id}`);
          process.exit(1);
        }

        out.success(`Campaign ${id} ${GLYPH.arrow} ${out.statusBadge(status)}`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });

  return cmd;
}
