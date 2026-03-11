/**
 * Contact commands for the TAP CLI.
 */

import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import {
  fetchContactFull,
  fetchContactMetrics,
  fetchContactOutcomes,
  fetchContactCampaigns,
  fetchContactCoverage,
  resolveContactByEmail,
} from "../lib/contact-queries.js";
import {
  field,
  fieldList,
  sectionHeader,
  warningBlock,
  sparkbar,
  relativeDate,
  percentage,
  warmthColour,
  navHint,
  shortDate,
} from "../ui/detail.js";

/**
 * Show full contact detail view.
 * Exported so interactive mode can call it directly.
 */
export async function showContact(
  contactId: string,
  opts: { workspace?: string; json?: boolean },
): Promise<void> {
  const spinner = ora("Loading contact...").start();

  try {
    const supabase = getClient();

    // If it looks like an email, resolve to ID
    let resolvedId = contactId;
    if (contactId.includes("@")) {
      const wsId = await resolveWorkspaceId(supabase, opts.workspace);
      const id = await resolveContactByEmail(supabase, wsId, contactId);
      if (!id) {
        spinner.stop();
        out.error(`No contact found with email: ${contactId}`);
        process.exit(1);
      }
      resolvedId = id;
    }

    // 5 parallel queries
    const [contact, metrics, outcomes, campaigns, coverage] = await Promise.all(
      [
        fetchContactFull(supabase, resolvedId),
        fetchContactMetrics(supabase, resolvedId),
        fetchContactOutcomes(supabase, resolvedId, 10),
        fetchContactCampaigns(supabase, resolvedId),
        fetchContactCoverage(supabase, resolvedId, 5),
      ],
    );

    spinner.stop();

    if (!contact) {
      out.error(`Contact not found: ${contactId}`);
      process.exit(1);
    }

    if (opts.json) {
      out.json({ contact, metrics, outcomes, campaigns, coverage });
      return;
    }

    // -- Header --
    const warmth = metrics?.warmth_level;
    const warmthStr = warmth
      ? warmthColour(warmth)(warmth)
      : "";
    console.log("");
    console.log(
      `  ${chalk.bold(contact.name || contact.email)}${warmthStr ? "  " + warmthStr : ""}`,
    );
    const parts = [
      contact.outlet,
      contact.role,
      contact.email,
    ].filter(Boolean);
    console.log(`  ${chalk.dim(parts.join("  ·  "))}`);
    console.log(chalk.dim(`  ${"\u2500".repeat(44)}`));

    // -- Relationship --
    if (metrics) {
      sectionHeader("Relationship");
      const warmthScore = metrics.warmth_score ?? 0;
      const warmthMax = 75;
      console.log(
        field(
          "Warmth",
          `${warmthColour(metrics.warmth_level)(metrics.warmth_level || "unknown")} ${sparkbar(warmthScore / warmthMax)} ${warmthScore}/${warmthMax}`,
        ),
      );
      console.log(field("Pipeline", contact.pipeline_status));
      console.log(
        field(
          "Response rate",
          `${percentage(metrics.response_rate)} ${sparkbar(metrics.response_rate)}`,
        ),
      );
      console.log(
        field(
          "Avg response",
          metrics.avg_response_days !== null
            ? `${metrics.avg_response_days.toFixed(1)} days`
            : null,
        ),
      );
      console.log(field("Total pitches", metrics.total_pitches));
      console.log(field("Positive", metrics.positive_outcomes));
      console.log(
        field("Last contacted", relativeDate(metrics.last_contacted_at)),
      );
      console.log(
        field("Last response", relativeDate(contact.last_response_at)),
      );
    }

    // -- Intelligence --
    const hasIntel =
      contact.platform_type ||
      contact.genres?.length ||
      contact.geographic_scope ||
      contact.best_timing ||
      contact.bbc_station ||
      contact.submission_guidelines ||
      contact.pitch_tips?.length;

    if (hasIntel) {
      sectionHeader("Intelligence");
      console.log(field("Platform", contact.platform_type));
      console.log(fieldList("Genres", contact.genres));
      console.log(field("Geographic", contact.geographic_scope));
      console.log(field("Best timing", contact.best_timing));
      if (contact.bbc_station) {
        console.log(field("BBC station", contact.bbc_station));
        console.log(fieldList("BBC shows", contact.bbc_shows));
      }
      if (contact.submission_guidelines) {
        console.log(
          field(
            "Guidelines",
            out.truncate(contact.submission_guidelines, 60),
          ),
        );
      }
      if (contact.pitch_tips && contact.pitch_tips.length > 0) {
        console.log(field("Pitch tips", ""));
        for (const tip of contact.pitch_tips) {
          console.log(`${"".padEnd(20)}${chalk.dim(".")} ${tip}`);
        }
      }
      console.log(field("Confidence", contact.enrichment_confidence, {
        colour: contact.enrichment_confidence === "High"
          ? chalk.green
          : contact.enrichment_confidence === "Medium"
            ? chalk.yellow
            : chalk.red,
      }));
      console.log(field("Enriched", relativeDate(contact.enriched_at)));
    }

    // -- Campaigns --
    if (campaigns.length > 0) {
      sectionHeader("Campaigns", `${campaigns.length}`);
      for (const c of campaigns) {
        const label = c.artist_name
          ? `${c.artist_name} -- ${c.project_name}`
          : c.project_name;
        console.log(
          `  ${out.truncate(label, 32)?.padEnd(32)}  ${out.pitchStatusBadge(c.pitch_status)?.padEnd(14)}  ${shortDate(c.last_pitched_at)}`,
        );
      }
    }

    // -- Recent Outcomes --
    if (outcomes.length > 0) {
      sectionHeader("Recent Outcomes", `${outcomes.length}`);
      for (const o of outcomes) {
        const campaign = o.artist_name
          ? `${o.artist_name} -- ${o.project_name}`
          : o.project_name || "";
        console.log(
          `  ${out.pitchStatusBadge(o.outcome_type)?.padEnd(14)}  ${out.truncate(campaign, 28)?.padEnd(28)}  ${shortDate(o.occurred_at)}`,
        );
        if (o.notes) {
          console.log(`${"".padEnd(4)}${chalk.dim(`"${out.truncate(o.notes, 50)}"`)}`)
        }
      }
    }

    // -- Coverage --
    if (coverage.length > 0) {
      sectionHeader("Coverage", `${coverage.length}`);
      for (const c of coverage) {
        console.log(
          `  ${out.truncate(c.title, 34)?.padEnd(34)}  ${chalk.dim(c.type?.padEnd(12) || "")}  ${shortDate(c.publish_date)}`,
        );
        if (c.url) {
          console.log(`${"".padEnd(4)}${chalk.dim(c.url)}`);
        }
      }
    }

    // -- Warnings --
    const warnings: string[] = [];
    if (contact.pitch_embargo_until) {
      const embargo = new Date(contact.pitch_embargo_until);
      if (embargo > new Date()) {
        warnings.push(
          `Pitch embargo until ${embargo.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`,
        );
      }
    }
    if (contact.cooling_off) {
      warnings.push("Contact is in cooling off period");
    }
    if (contact.enriched_at) {
      const daysSinceEnriched = Math.floor(
        (Date.now() - new Date(contact.enriched_at).getTime()) / 86400000,
      );
      if (daysSinceEnriched > 90) {
        warnings.push(
          `Enrichment data is ${daysSinceEnriched} days old (consider re-enriching)`,
        );
      }
    }
    if (warnings.length > 0) {
      warningBlock(warnings);
    }

    // -- Navigation hints --
    const shortId = contact.id.slice(0, 8);
    navHint([
      `tap open ${shortId}`,
      `tap contacts history ${shortId}`,
    ]);

    console.log("");
  } catch (err) {
    spinner.stop();
    out.error(err instanceof Error ? err.message : "Unknown error");
    process.exit(1);
  }
}

export function contactsCommand(): Command {
  const cmd = new Command("contacts").description("Manage contacts");

  cmd
    .command("list")
    .description("List contacts")
    .option("-s, --status <status>", "Pipeline status filter")
    .option("-g, --genre <genre>", "Genre filter")
    .option("--bbc", "Only BBC contacts")
    .option("--warm", "Only warm/hot contacts")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("-l, --limit <n>", "Max results", "30")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const spinner = ora("Fetching contacts...").start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        let query = supabase
          .from("tap_contacts")
          .select(
            "id, name, email, outlet, role, genres, bbc_station, pipeline_status, enrichment_confidence",
            { count: "exact" },
          )
          .eq("workspace_id", wsId)
          .order("name", { ascending: true })
          .limit(parseInt(opts.limit));

        if (opts.status) query = query.eq("pipeline_status", opts.status);
        if (opts.genre) query = query.contains("genres", [opts.genre]);
        if (opts.bbc) query = query.not("bbc_station", "is", null);

        const { data, count, error } = await query;
        spinner.stop();

        if (error) {
          out.error(error.message);
          process.exit(1);
        }

        if (opts.json) {
          out.json({ contacts: data, total: count });
          return;
        }

        if (!data || data.length === 0) {
          out.info("No contacts found");
          return;
        }

        out.table(
          ["Name", "Email", "Outlet", "Status", "Confidence"],
          data.map((c) => [
            out.truncate(c.name, 25),
            out.truncate(c.email, 30),
            out.truncate(c.outlet, 20) || "\u2014",
            c.pipeline_status || "new",
            out.confidenceBadge(c.enrichment_confidence),
          ]),
        );

        out.info(`${data.length} of ${count || 0} contacts`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });

  cmd
    .command("show")
    .description("Show full contact details")
    .argument("<id-or-email>", "Contact ID or email address")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (idOrEmail, opts) => {
      await showContact(idOrEmail, opts);
    });

  cmd
    .command("search")
    .description("Search contacts")
    .argument("<query>", "Search query")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (query, opts) => {
      const spinner = ora("Searching...").start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);
        const q = query.replace(/'/g, "''");

        const { data, error } = await supabase
          .from("tap_contacts")
          .select(
            "id, name, email, outlet, role, bbc_station, enrichment_confidence",
          )
          .eq("workspace_id", wsId)
          .or(
            `name.ilike.%${q}%,email.ilike.%${q}%,outlet.ilike.%${q}%,bbc_station.ilike.%${q}%`,
          )
          .order("name", { ascending: true })
          .limit(20);

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
          out.info(`No contacts matching "${query}"`);
          return;
        }

        out.table(
          ["Name", "Email", "Outlet", "BBC", "Confidence"],
          data.map((c) => [
            out.truncate(c.name, 25),
            out.truncate(c.email, 30),
            out.truncate(c.outlet, 20) || "\u2014",
            c.bbc_station || "\u2014",
            out.confidenceBadge(c.enrichment_confidence),
          ]),
        );

        out.info(`${data.length} results`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });

  cmd
    .command("add")
    .description("Quick-add a contact")
    .requiredOption("-n, --name <name>", "Contact name")
    .requiredOption("-e, --email <email>", "Email address")
    .option("-o, --outlet <outlet>", "Outlet / publication / station")
    .option(
      "-r, --role <role>",
      "Role (presenter, producer, journalist, playlist_curator)",
    )
    .option("-g, --genre <genres>", "Genres (comma-separated)")
    .option(
      "-p, --platform <type>",
      "Platform type (radio, press, playlist, podcast, blog)",
    )
    .option("-b, --bbc-station <station>", "BBC station name")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const spinner = ora("Adding contact...").start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        const genres = opts.genre
          ? opts.genre.split(",").map((g: string) => g.trim())
          : null;

        const { data, error } = await supabase
          .from("tap_contacts")
          .insert({
            workspace_id: wsId,
            name: opts.name,
            email: opts.email.toLowerCase().trim(),
            outlet: opts.outlet || null,
            role: opts.role || null,
            genres,
            platform_type: opts.platform || null,
            bbc_station: opts.bbcStation || null,
            pipeline_status: "new",
          })
          .select("id, name, email")
          .single();

        spinner.stop();

        if (error) {
          if (error.code === "23505") {
            out.error(
              `Contact with email ${opts.email} already exists in this workspace`,
            );
          } else {
            out.error(error.message);
          }
          process.exit(1);
        }

        if (opts.json) {
          out.json(data);
          return;
        }

        out.success(`Added ${data.name} <${data.email}>`);
        out.info(`ID: ${data.id}`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });

  cmd
    .command("enrich")
    .description("Queue a contact for AI enrichment")
    .argument("<id>", "Contact ID")
    .action(async (id) => {
      const spinner = ora("Queueing enrichment...").start();

      try {
        const supabase = getClient();

        const { error } = await supabase
          .from("tap_contacts")
          .update({ enrichment_source: "queued" })
          .eq("id", id);

        spinner.stop();

        if (error) {
          out.error(error.message);
          process.exit(1);
        }

        out.success(`Contact ${id} queued for enrichment`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });

  cmd
    .command("import")
    .description("Import contacts from CSV")
    .argument("<file>", "CSV file path")
    .option("-w, --workspace <id>", "Workspace ID")
    .action(async (file, opts) => {
      out.info(
        `CSV import via CLI not yet implemented. Use the TAP web interface at tap.totalaudiopromo.com`,
      );
      out.info(`File: ${file}`);
      if (opts.workspace) out.info(`Workspace: ${opts.workspace}`);
    });

  return cmd;
}
