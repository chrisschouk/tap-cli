/**
 * Watch command -- live campaign monitor.
 *
 * Polls Supabase every 30 seconds and renders a compact dashboard.
 * Like htop for PR campaigns.
 *
 * Usage:
 *   tap watch                -- workspace overview
 *   tap watch <campaign-id>  -- campaign focus
 *   tap watch --no-clear     -- log mode (append instead of redraw)
 */

import { Command } from "commander";
import chalk from "chalk";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import { GLYPH, COLOUR } from "../ui/theme.js";
import { relativeDate, sparkbar, percentage } from "../ui/detail.js";

interface ActivityItem {
  time: string;
  type: string;
  label: string;
  isNew: boolean;
}

export function watchCommand(): Command {
  return new Command("watch")
    .description("Live campaign monitor")
    .argument("[campaign-id]", "Campaign ID for focused view")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--interval <seconds>", "Poll interval in seconds", "30")
    .option("--no-clear", "Log mode -- append instead of redraw")
    .action(async (campaignId, opts) => {
      const interval = Math.max(10, parseInt(opts.interval));

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        let lastSeenIds = new Set<string>();
        let tickCount = 0;

        const render = async () => {
          try {
            const now = new Date();
            const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

            if (campaignId) {
              // -- Campaign focus mode --
              const [campResult, contactsResult, outcomesResult, coverageResult] =
                await Promise.all([
                  supabase
                    .from("tap_projects")
                    .select("id, name, artist_name, status")
                    .eq("id", campaignId)
                    .single(),
                  supabase
                    .from("campaign_contacts")
                    .select("pitch_status, contact_id")
                    .eq("project_id", campaignId),
                  supabase
                    .from("tap_contact_outcomes")
                    .select("id, outcome_type, contact_id, occurred_at")
                    .eq("project_id", campaignId)
                    .gte("occurred_at", twoHoursAgo.toISOString())
                    .order("occurred_at", { ascending: false })
                    .limit(10),
                  supabase
                    .from("coverage_clips")
                    .select("id, title, publish_date")
                    .eq("campaign_id", campaignId)
                    .order("publish_date", { ascending: false })
                    .limit(5),
                ]);

              if (campResult.error || !campResult.data) {
                out.error(`Campaign not found: ${campaignId}`);
                process.exit(1);
              }

              const campaign = campResult.data;
              const contacts = contactsResult.data || [];
              const outcomes = outcomesResult.data || [];

              // Resolve contact names for outcomes
              const outcomeContactIds = [...new Set(outcomes.map((o) => o.contact_id))];
              let contactNameMap = new Map<string, string>();
              if (outcomeContactIds.length > 0) {
                const { data: names } = await supabase
                  .from("tap_contacts")
                  .select("id, name")
                  .in("id", outcomeContactIds);
                if (names) {
                  contactNameMap = new Map(names.map((n) => [n.id, n.name || n.id.slice(0, 8)]));
                }
              }

              // Stats
              const total = contacts.length;
              const pitched = contacts.filter(
                (c) => c.pitch_status && c.pitch_status !== "not_pitched",
              ).length;
              const replied = contacts.filter(
                (c) => c.pitch_status === "replied",
              ).length;
              const pctPitched = total > 0 ? Math.round((pitched / total) * 100) : 0;
              const pctReplied = pitched > 0 ? Math.round((replied / pitched) * 100) : 0;

              // New outcomes
              const currentIds = new Set(outcomes.map((o) => o.id));
              const newIds = tickCount > 0
                ? new Set([...currentIds].filter((id) => !lastSeenIds.has(id)))
                : new Set<string>();
              lastSeenIds = currentIds;

              // Render
              if (opts.clear !== false) console.clear();

              const timeStr = now.toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });

              const label = campaign.artist_name
                ? `${campaign.artist_name} -- ${campaign.name}`
                : campaign.name;

              console.log(
                `  ${chalk.hex(COLOUR.primary)("tap watch")} ${chalk.dim(GLYPH.divider + GLYPH.divider)} ${label} ${chalk.dim(GLYPH.dot)} last checked ${timeStr}`,
              );
              console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));
              console.log("");

              console.log(
                `  ${chalk.dim("Contacts")} ${total}  ${chalk.dim(GLYPH.dot)}  ` +
                  `${chalk.dim("Pitched")} ${chalk.hex(COLOUR.primary)(`${pctPitched}%`)}  ${chalk.dim(GLYPH.dot)}  ` +
                  `${chalk.dim("Reply rate")} ${chalk.hex(COLOUR.success)(`${pctReplied}%`)}`,
              );

              // Pitch funnel compact
              const statusCounts: Record<string, number> = {};
              for (const c of contacts) {
                const s = c.pitch_status || "not_pitched";
                statusCounts[s] = (statusCounts[s] || 0) + 1;
              }
              const funnelParts = Object.entries(statusCounts)
                .map(([s, n]) => `${out.pitchStatusBadge(s)} ${n}`)
                .join(`  ${chalk.dim(GLYPH.dot)}  `);
              console.log(`  ${funnelParts}`);

              // Recent activity
              if (outcomes.length > 0) {
                console.log("");
                console.log(
                  `  ${chalk.bold("Recent Activity")} ${chalk.dim("(last 2h)")}`,
                );
                console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));

                for (const o of outcomes) {
                  const time = new Date(o.occurred_at).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  const contactName = contactNameMap.get(o.contact_id) || o.contact_id.slice(0, 8);
                  const isNew = newIds.has(o.id);
                  console.log(
                    `  ${chalk.dim(time)}  ${out.pitchStatusBadge(o.outcome_type)?.padEnd(14)}  ${contactName}${isNew ? chalk.red.bold("  NEW") : ""}`,
                  );
                }
              }

              // Coverage
              const clips = coverageResult.data || [];
              if (clips.length > 0) {
                console.log("");
                console.log(`  ${chalk.bold("Coverage")}`);
                console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));
                for (const clip of clips) {
                  console.log(
                    `  ${out.truncate(clip.title, 40)?.padEnd(40)}  ${relativeDate(clip.publish_date)}`,
                  );
                }
              }

            } else {
              // -- Workspace overview mode --
              const [campaignsResult, outcomesResult, queueResult] =
                await Promise.all([
                  supabase
                    .from("tap_projects")
                    .select("id, name, artist_name, status")
                    .eq("workspace_id", wsId)
                    .eq("status", "active"),
                  supabase
                    .from("tap_contact_outcomes")
                    .select("id, outcome_type, contact_id, project_id, occurred_at")
                    .eq("workspace_id", wsId)
                    .gte("occurred_at", twoHoursAgo.toISOString())
                    .order("occurred_at", { ascending: false })
                    .limit(10),
                  supabase
                    .from("campaign_contacts")
                    .select("pitch_status, project_id")
                    .eq("pitch_status", "not_pitched"),
                ]);

              const campaigns = campaignsResult.data || [];
              const outcomes = outcomesResult.data || [];

              // Get campaign contacts counts for active campaigns
              const campaignIds = campaigns.map((c) => c.id);
              let campaignContactsResult: Array<{ project_id: string; pitch_status: string | null }> = [];
              if (campaignIds.length > 0) {
                const { data } = await supabase
                  .from("campaign_contacts")
                  .select("project_id, pitch_status")
                  .in("project_id", campaignIds);
                campaignContactsResult = data || [];
              }

              // Resolve names for outcomes
              const allIds = [
                ...new Set([
                  ...outcomes.map((o) => o.contact_id),
                ]),
              ];
              let contactNameMap = new Map<string, string>();
              if (allIds.length > 0) {
                const { data: names } = await supabase
                  .from("tap_contacts")
                  .select("id, name")
                  .in("id", allIds);
                if (names) {
                  contactNameMap = new Map(names.map((n) => [n.id, n.name || n.id.slice(0, 8)]));
                }
              }

              const campaignMap = new Map(campaigns.map((c) => [c.id, c]));

              // New outcomes
              const currentIds = new Set(outcomes.map((o) => o.id));
              const newIds = tickCount > 0
                ? new Set([...currentIds].filter((id) => !lastSeenIds.has(id)))
                : new Set<string>();
              lastSeenIds = currentIds;

              // Queue counts
              const followUpThreshold = new Date();
              followUpThreshold.setDate(followUpThreshold.getDate() - 3);
              let followUpCount = 0;
              let unpitchedCount = 0;

              if (campaignIds.length > 0) {
                const { count: fCount } = await supabase
                  .from("campaign_contacts")
                  .select("id", { count: "exact", head: true })
                  .in("project_id", campaignIds)
                  .eq("pitch_status", "sent")
                  .lt("last_pitched_at", followUpThreshold.toISOString());
                followUpCount = fCount || 0;

                const { count: uCount } = await supabase
                  .from("campaign_contacts")
                  .select("id", { count: "exact", head: true })
                  .in("project_id", campaignIds)
                  .eq("pitch_status", "not_pitched");
                unpitchedCount = uCount || 0;
              }

              const { count: unenrichedCount } = await supabase
                .from("tap_contacts")
                .select("id", { count: "exact", head: true })
                .eq("workspace_id", wsId)
                .is("enriched_at", null);

              // Render
              if (opts.clear !== false) console.clear();

              const timeStr = now.toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });

              console.log(
                `  ${chalk.hex(COLOUR.primary)("tap watch")} ${chalk.dim(GLYPH.divider + " live " + GLYPH.dot)} last checked ${timeStr}`,
              );
              console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));

              // Active campaigns
              if (campaigns.length > 0) {
                console.log("");
                console.log(`  ${chalk.bold("Active Campaigns")}`);
                console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));

                for (const camp of campaigns) {
                  const contacts = campaignContactsResult.filter(
                    (c) => c.project_id === camp.id,
                  );
                  const total = contacts.length;
                  const pitched = contacts.filter(
                    (c) => c.pitch_status && c.pitch_status !== "not_pitched",
                  ).length;
                  const replied = contacts.filter(
                    (c) => c.pitch_status === "replied",
                  ).length;

                  const pctPitched = total > 0 ? Math.round((pitched / total) * 100) : 0;
                  const pctReplied = pitched > 0 ? Math.round((replied / pitched) * 100) : 0;

                  const label = camp.artist_name
                    ? `${camp.artist_name} -- ${camp.name}`
                    : camp.name;

                  console.log(
                    `  ${out.truncate(label, 30)?.padEnd(30)}  ${String(pctPitched).padStart(3)}% pitched  ${String(pctReplied).padStart(3)}% reply`,
                  );
                }
              }

              // Recent activity
              if (outcomes.length > 0) {
                console.log("");
                console.log(
                  `  ${chalk.bold("Recent Activity")} ${chalk.dim("(last 2h)")}`,
                );
                console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));

                for (const o of outcomes) {
                  const time = new Date(o.occurred_at).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  const contactName = contactNameMap.get(o.contact_id) || o.contact_id.slice(0, 8);
                  const camp = o.project_id ? campaignMap.get(o.project_id) : null;
                  const campName = camp?.name || "";
                  const isNew = newIds.has(o.id);

                  console.log(
                    `  ${chalk.dim(time)}  ${out.pitchStatusBadge(o.outcome_type)?.padEnd(12)}  ${contactName}${campName ? chalk.dim(` -- ${campName}`) : ""}${isNew ? chalk.red.bold("  NEW") : ""}`,
                  );
                }
              }

              // Queue summary
              console.log("");
              console.log(`  ${chalk.bold("Queue")}`);
              console.log(chalk.dim(`  ${GLYPH.divider.repeat(52)}`));
              console.log(
                `  ${followUpCount} follow-ups due  ${chalk.dim(GLYPH.dot)}  ${unpitchedCount} unpitched  ${chalk.dim(GLYPH.dot)}  ${unenrichedCount || 0} unenriched`,
              );
            }

            // Footer
            console.log("");
            console.log(
              chalk.dim(`  Ctrl+C to exit ${GLYPH.dot} r to refresh ${GLYPH.dot} polling every ${interval}s`),
            );

            tickCount++;
          } catch (err) {
            // Non-fatal: log and continue
            console.error(
              chalk.dim(`  Poll error: ${err instanceof Error ? err.message : "unknown"}`),
            );
          }
        };

        // Initial render
        await render();

        // Set up polling interval
        const timer = setInterval(render, interval * 1000);

        // Handle manual refresh with 'r' key
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.on("data", async (key) => {
            if (key.toString() === "r") {
              await render();
            }
            // Ctrl+C
            if (key[0] === 3) {
              clearInterval(timer);
              if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
              }
              console.log("");
              console.log(chalk.dim("  Stopped."));
              process.exit(0);
            }
          });
        }

        // Graceful cleanup on SIGINT
        process.on("SIGINT", () => {
          clearInterval(timer);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          console.log("");
          console.log(chalk.dim("  Stopped."));
          process.exit(0);
        });
      } catch (err) {
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });
}
