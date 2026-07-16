/**
 * Campaign commands for the TAP CLI.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { getClient, resolveWorkspaceId, hasApiKey } from "../auth.js";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import { GLYPH, COLOUR, WARMTH_COLOUR } from "../ui/theme.js";
import { sectionHeader, sparkbar, shortDate, navHint, ansiPadEnd } from "../ui/detail.js";
import { handleError } from "../ui/errors.js";
import { blank } from "../ui/format.js";

function renderCoverage(clips: Array<{ title: string | null; type: string | null; url: string | null; publish_date: string | null }>): void {
  sectionHeader("Coverage", `${clips.length}`);
  for (const clip of clips) {
    console.log(
      `  ${out.truncate(clip.title, 34)?.padEnd(34)}  ${chalk.dim(clip.type?.padEnd(12) || "")}  ${shortDate(clip.publish_date)}`,
    );
    if (clip.url) {
      console.log(`    ${chalk.dim(clip.url)}`);
    }
  }
}

function renderOutcomes(outcomes: Array<{ outcome_type: string }>): void {
  const outcomeDist: Record<string, number> = {};
  for (const o of outcomes) {
    outcomeDist[o.outcome_type] = (outcomeDist[o.outcome_type] || 0) + 1;
  }
  sectionHeader("Outcomes", `${outcomes.length}`);
  const sorted = Object.entries(outcomeDist).sort(([, a], [, b]) => b - a);
  for (const [type, count] of sorted) {
    const ratio = count / outcomes.length;
    console.log(
      `  ${ansiPadEnd(type.replace(/_/g, " "), 18)}${sparkbar(ratio)}  ${String(count).padStart(4)}`,
    );
  }
}

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
    if (hasApiKey()) {
      const res = await restRequest<{
        campaign: any;
        stats: any;
      }>(`/api/v1/campaigns/${encodeURIComponent(id)}`);

      const contactsRes = await restRequest<{
        contacts: any[];
      }>(`/api/v1/campaigns/${encodeURIComponent(id)}/contacts`, {
        query: { limit: 100 },
      });

      const outcomesRes = await restRequest<{
        outcomes: any[];
      }>("/api/v1/outcomes", {
        query: { campaign_id: id, limit: 100 },
      });

      spinner.stop();

      const campaign = res.campaign;
      const contacts = contactsRes.contacts;
      const outcomes = outcomesRes.outcomes;

      if (opts.json) {
        out.json({ campaign, contacts, outcomes });
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
      if (campaign.release_title) {
        console.log(`  ${chalk.dim("Release")} ${campaign.release_title}`);
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
        const rows = contacts.map((c) => [
          out.truncate(c.contact?.name || c.contact?.email || "", 22),
          out.truncate(c.contact?.outlet || "", 16) || "—",
          out.pitchStatusBadge(c.pitch_status),
          shortDate(c.last_pitched_at),
        ]);

        console.log("");
        out.table(["Name", "Outlet", "Pitch Status", "Last Pitched"], rows);
      }

      // -- Health --
      const total = contacts.length;
      console.log("");
      sectionHeader("Health");
      console.log(
        `  ${chalk.dim("Contacts")} ${total}  ${chalk.dim(GLYPH.dot)}  ` +
          `${chalk.dim("Pitched")} ${chalk.hex(COLOUR.primary)(`${res.stats?.pitched_count ?? 0}`)}  ${chalk.dim(GLYPH.dot)}  ` +
          `${chalk.dim("Replied")} ${chalk.hex(COLOUR.success)(`${res.stats?.replied_count ?? 0}`)}`
      );

      // outcomes mapping
      if (outcomes.length > 0) {
        sectionHeader("Outcomes", `${outcomes.length}`);
        const outcomeDist: Record<string, number> = {};
        for (const o of outcomes) {
          outcomeDist[o.outcome_type] = (outcomeDist[o.outcome_type] || 0) + 1;
        }
        const sorted = Object.entries(outcomeDist).sort(([, a], [, b]) => b - a);
        for (const [type, count] of sorted) {
          const ratio = count / outcomes.length;
          console.log(
            `  ${ansiPadEnd(type.replace(/_/g, " "), 18)}${sparkbar(ratio)}  ${String(count).padStart(4)}`,
          );
        }
      }

      navHint([`tap open ${id.slice(0, 8)}`]);
      console.log("");
      return;
    }

    const supabase = getClient();

    // Fetch campaign + contacts + outcomes + coverage in parallel
    const [campResult, contactsResult] = await Promise.all([
      supabase
        .from("tap_projects")
        .select(
          "id, workspace_id, name, artist_name, status, release_name, release_date, goal, created_at, momentum_score, momentum_trend",
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
            out.truncate(contact?.outlet, 16) || "—",
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
          `  ${ansiPadEnd(out.pitchStatusBadge(status) || "", 16)}${sparkbar(ratio)}  ${String(count).padStart(4)}`,
        );
      }
      // Any other statuses
      for (const [status, count] of Object.entries(statusCounts)) {
        if (funnelOrder.includes(status)) continue;
        const ratio = count / total;
        console.log(
          `  ${ansiPadEnd(out.pitchStatusBadge(status) || "", 16)}${sparkbar(ratio)}  ${String(count).padStart(4)}`,
        );
      }
    }

    // -- Progressive disclosure + actions (TTY only) --
    if (process.stdout.isTTY) {
      const { campaignActionMenu } = await import("../ui/actions.js");

      while (true) {
        const drillOptions: Array<{ value: string; label: string; hint?: string }> = [];

        // Viewing options
        if (coverageClips.length > 0) drillOptions.push({ value: "coverage", label: "View coverage", hint: `${coverageClips.length} clips` });
        if (outcomes.length > 0) drillOptions.push({ value: "outcomes", label: "View outcomes", hint: `${outcomes.length}` });

        // Action options
        const unpitchedCount = contacts.filter((c) => !c.pitch_status || c.pitch_status === "not_pitched").length;
        if (unpitchedCount > 0) drillOptions.push({ value: "pitch", label: "Pitch a contact", hint: `${unpitchedCount} unpitched` });
        drillOptions.push({ value: "outcome", label: "Log outcome" });
        drillOptions.push({ value: "status", label: "Change status", hint: campaign.status });
        drillOptions.push({ value: "open", label: "Open in TAP" });
        drillOptions.push({ value: "done", label: chalk.dim("Done") });

        const drill = (await prompts.select({
          message: "What next?",
          options: drillOptions,
        })) as string | symbol;

        if (prompts.isCancel(drill) || drill === "done") break;

        if (drill === "coverage") {
          renderCoverage(coverageClips);
        } else if (drill === "outcomes") {
          renderOutcomes(outcomes);
        } else {
          // Delegate to campaign action menu for pitch/outcome/status/open
          const result = await campaignActionMenu(supabase, campaign.workspace_id, id);
          if (result === "back") continue;
          // After an action, break out (state may have changed)
          break;
        }
      }
    } else {
      // Non-interactive: dump everything
      if (coverageClips.length > 0) renderCoverage(coverageClips);
      if (outcomes.length > 0) renderOutcomes(outcomes);
    }

    navHint([`tap open ${id.slice(0, 8)}`]);
    console.log("");
  } catch (err) {
    spinner.stop();
    handleError(err);
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
    .addHelpText("after", `
Examples:
  tap campaigns list
  tap campaigns list --status active
  tap campaigns list --json`)
    .action(async (opts) => {
      const spinner = out.spinner("Fetching campaigns...");

      try {
        if (hasApiKey()) {
          const res = await restRequest<{ campaigns: any[]; total: number }>("/api/v1/campaigns", {
            query: { status: opts.status },
          });

          spinner.stop();

          if (opts.json) {
            out.json(res.campaigns);
            return;
          }

          if (res.campaigns.length === 0) {
            out.info("No campaigns found");
            return;
          }

          out.table(
            ["Name", "Artist", "Status", "Release", "Warmth"],
            res.campaigns.map((c) => [
              out.truncate(c.name, 28),
              out.truncate(c.artist_name, 18) || "—",
              out.statusBadge(c.status),
              c.release_date || "—",
              "—", // Warmth breakdown not available via REST v1 list campaigns endpoint
            ]),
          );

          out.info(`${res.campaigns.length} campaigns`);
          navHint(["tap campaigns show <id>", "tap queue"]);
          blank();
          return;
        }

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

        if (error) {
          spinner.stop();
          out.error(error.message);
          process.exit(1);
        }

        if (opts.json) {
          spinner.stop();
          out.json(data);
          return;
        }

        if (!data || data.length === 0) {
          spinner.stop();
          out.info("No campaigns found");
          return;
        }

        // Batch-fetch warmth breakdown per campaign
        const campaignIds = data.map((c) => c.id);
        const [ccResult, metricsResult] = await Promise.all([
          supabase
            .from("campaign_contacts")
            .select("project_id, contact_id")
            .in("project_id", campaignIds),
          supabase
            .from("contact_relationship_metrics")
            .select("contact_id, warmth_level")
            .eq("workspace_id", wsId),
        ]);

        spinner.stop();

        // Build per-campaign warmth counts
        const warmthMap = new Map<string, string>();
        if (metricsResult.data) {
          for (const m of metricsResult.data) {
            if (m.warmth_level) warmthMap.set(m.contact_id, m.warmth_level);
          }
        }

        const campaignWarmth = new Map<string, Record<string, number>>();
        if (ccResult.data) {
          for (const cc of ccResult.data) {
            const w = warmthMap.get(cc.contact_id);
            if (!w) continue;
            const counts = campaignWarmth.get(cc.project_id) || { hot: 0, warm: 0, neutral: 0, cold: 0 };
            counts[w] = (counts[w] || 0) + 1;
            campaignWarmth.set(cc.project_id, counts);
          }
        }

        out.table(
          ["Name", "Artist", "Status", "Release", "Warmth"],
          data.map((c) => {
            const counts = campaignWarmth.get(c.id);
            let warmthCol = chalk.dim("—");
            if (counts) {
              const parts: string[] = [];
              if (counts.hot) parts.push(chalk.hex(WARMTH_COLOUR.hot)(`${counts.hot}h`));
              if (counts.warm) parts.push(chalk.hex(WARMTH_COLOUR.warm)(`${counts.warm}w`));
              if (counts.neutral) parts.push(chalk.hex(WARMTH_COLOUR.neutral)(`${counts.neutral}n`));
              if (counts.cold) parts.push(chalk.hex(WARMTH_COLOUR.cold)(`${counts.cold}c`));
              warmthCol = parts.length > 0 ? parts.join(" ") : chalk.dim("—");
            }
            return [
              out.truncate(c.name, 28),
              out.truncate(c.artist_name, 18) || "—",
              out.statusBadge(c.status),
              c.release_date || "—",
              warmthCol,
            ];
          }),
        );

        out.info(`${data.length} campaigns`);

        navHint([
          "tap campaigns show <id>",
          "tap queue",
        ]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
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
        if (hasApiKey()) {
          const res = await restRequest<{ campaign: any }>("/api/v1/campaigns", {
            method: "POST",
            body: {
              name: opts.name,
              artist_name: opts.artist,
              release_title: opts.release,
              release_date: opts.date,
              services: opts.channels ? opts.channels.split(",") : undefined,
            },
          });

          spinner.stop();
          out.success(`Campaign "${res.campaign.name}" created (${res.campaign.id})`);
          navHint([
            `tap campaigns show ${res.campaign.id.slice(0, 8)}`,
            "tap contacts search \"...\"",
          ]);
          blank();
          return;
        }

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

        navHint([
          `tap campaigns show ${data.id.slice(0, 8)}`,
          "tap contacts search \"...\"",
        ]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
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
        if (hasApiKey()) {
          await restRequest(`/api/v1/campaigns/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: { status },
          });

          spinner.stop();
          out.success(`Campaign ${id} ${GLYPH.arrow} ${out.statusBadge(status)}`);
          return;
        }

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
        handleError(err);
        process.exit(1);
      }
    });

  return cmd;
}
