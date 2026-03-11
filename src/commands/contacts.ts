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
      const confidenceColours: Record<string, (s: string) => string> = {
        High: chalk.green,
        Medium: chalk.yellow,
        Low: chalk.red,
      };
      console.log(field("Confidence", contact.enrichment_confidence, {
        colour: confidenceColours[contact.enrichment_confidence || ""] || chalk.red,
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

/**
 * Show cross-campaign timeline for a contact.
 * Exported so interactive mode can call it directly.
 */
export async function showHistory(
  contactId: string,
  opts: { workspace?: string; limit?: string; json?: boolean },
): Promise<void> {
  const spinner = ora("Loading history...").start();

  try {
    const supabase = getClient();
    const limit = parseInt(opts.limit || "50");

    // Resolve email to ID
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

    // Parallel: contact name, outcomes, pitch drafts
    const [contactResult, outcomesResult, draftsResult] = await Promise.all([
      supabase
        .from("tap_contacts")
        .select("id, name, email, outlet")
        .eq("id", resolvedId)
        .single(),
      supabase
        .from("tap_contact_outcomes")
        .select("id, outcome_type, notes, occurred_at, project_id")
        .eq("contact_id", resolvedId)
        .order("occurred_at", { ascending: false })
        .limit(limit),
      supabase
        .from("campaign_pitch_drafts")
        .select("id, subject, send_status, sent_at, campaign_id, created_at")
        .eq("contact_id", resolvedId)
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);

    if (contactResult.error || !contactResult.data) {
      spinner.stop();
      out.error(`Contact not found: ${contactId}`);
      process.exit(1);
    }

    const contact = contactResult.data;
    const outcomeData = outcomesResult.data || [];
    const draftsData = draftsResult.data || [];

    // Resolve project names
    const projectIds = [
      ...new Set([
        ...outcomeData.map((o) => o.project_id).filter(Boolean),
        ...draftsData.map((d) => d.campaign_id).filter(Boolean),
      ]),
    ];

    let projectMap = new Map<string, { name: string; artist_name: string | null }>();
    if (projectIds.length > 0) {
      const { data: projects } = await supabase
        .from("tap_projects")
        .select("id, name, artist_name")
        .in("id", projectIds);

      if (projects) {
        projectMap = new Map(projects.map((p) => [p.id, p]));
      }
    }

    spinner.stop();

    // Merge into unified timeline
    interface TimelineEvent {
      date: string;
      type: string;
      campaign: string;
      detail: string | null;
    }

    const events: TimelineEvent[] = [];

    for (const o of outcomeData) {
      const project = o.project_id ? projectMap.get(o.project_id) : null;
      const campaign = project
        ? project.artist_name
          ? `${project.artist_name} -- ${project.name}`
          : project.name
        : "";
      events.push({
        date: o.occurred_at || "",
        type: o.outcome_type,
        campaign,
        detail: o.notes,
      });
    }

    for (const d of draftsData) {
      if (d.send_status === "sent" && d.sent_at) {
        const project = d.campaign_id ? projectMap.get(d.campaign_id) : null;
        const campaign = project
          ? project.artist_name
            ? `${project.artist_name} -- ${project.name}`
            : project.name
          : "";
        events.push({
          date: d.sent_at,
          type: "pitched",
          campaign,
          detail: d.subject ? `Subject: ${d.subject}` : null,
        });
      }
    }

    // Sort by date descending
    events.sort((a, b) => {
      const aTime = a.date ? new Date(a.date).getTime() : 0;
      const bTime = b.date ? new Date(b.date).getTime() : 0;
      return bTime - aTime;
    });

    const limited = events.slice(0, limit);

    if (opts.json) {
      out.json({ contact, events: limited });
      return;
    }

    // Header
    console.log("");
    console.log(
      `  ${chalk.bold(contact.name || contact.email)}${contact.outlet ? chalk.dim(` -- ${contact.outlet}`) : ""}`,
    );
    console.log(`  ${chalk.dim(`Timeline (${limited.length} events)`)}`);
    console.log(chalk.dim(`  ${"\u2500".repeat(44)}`));
    console.log("");

    if (limited.length === 0) {
      out.info("No history found for this contact");
    } else {
      // Unique campaigns for summary
      const uniqueCampaigns = new Set(limited.map((e) => e.campaign).filter(Boolean));

      for (const e of limited) {
        const dateStr = shortDate(e.date);
        console.log(
          `  ${dateStr.padEnd(8)}${out.pitchStatusBadge(e.type)?.padEnd(14)}  ${chalk.dim(out.truncate(e.campaign, 30) || "")}`,
        );
        if (e.detail) {
          console.log(`           ${chalk.dim(out.truncate(e.detail, 50))}`);
        }
      }

      console.log(chalk.dim(`  ${"\u2500".repeat(44)}`));
      console.log(
        chalk.dim(`  ${limited.length} events across ${uniqueCampaigns.size} campaign${uniqueCampaigns.size === 1 ? "" : "s"}`),
      );
    }

    navHint([
      `tap contacts show ${contact.id.slice(0, 8)}`,
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
    .option("--sort <field>", "Sort by: name, warmth, response, last-contacted", "name")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("-l, --limit <n>", "Max results", "50")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const spinner = ora("Fetching contacts...").start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        // Fetch contacts
        let query = supabase
          .from("tap_contacts")
          .select(
            "id, name, email, outlet, pipeline_status, enrichment_confidence, last_contacted_at",
            { count: "exact" },
          )
          .eq("workspace_id", wsId)
          .order("name", { ascending: true })
          .limit(opts.warm ? 500 : parseInt(opts.limit));

        if (opts.status) query = query.eq("pipeline_status", opts.status);
        if (opts.genre) query = query.contains("genres", [opts.genre]);
        if (opts.bbc) query = query.not("bbc_station", "is", null);

        // Fetch metrics for warmth/response data
        const [contactResult, metricsResult] = await Promise.all([
          query,
          supabase
            .from("contact_relationship_metrics")
            .select("contact_id, warmth_level, warmth_score, response_rate")
            .eq("workspace_id", wsId),
        ]);

        spinner.stop();

        const { data, count, error } = contactResult;

        if (error) {
          out.error(error.message);
          process.exit(1);
        }

        if (!data || data.length === 0) {
          out.info("No contacts found");
          return;
        }

        // Build metrics lookup
        const metricsMap = new Map<string, { warmth_level: string | null; warmth_score: number | null; response_rate: number }>();
        if (metricsResult.data) {
          for (const m of metricsResult.data) {
            metricsMap.set(m.contact_id, m);
          }
        }

        // Merge contact + metrics
        type ContactRow = {
          id: string;
          name: string | null;
          email: string;
          outlet: string | null;
          pipeline_status: string | null;
          enrichment_confidence: string | null;
          last_contacted_at: string | null;
          warmth_level: string | null;
          warmth_score: number | null;
          response_rate: number;
        };

        let merged: ContactRow[] = data.map((c) => {
          const m = metricsMap.get(c.id);
          return {
            ...c,
            warmth_level: m?.warmth_level || null,
            warmth_score: m?.warmth_score || null,
            response_rate: m?.response_rate || 0,
          };
        });

        // Apply --warm filter
        if (opts.warm) {
          merged = merged.filter(
            (c) => c.warmth_level === "hot" || c.warmth_level === "warm",
          );
        }

        // Apply sort
        const sortField = opts.sort;
        if (sortField === "warmth") {
          merged.sort((a, b) => (b.warmth_score ?? 0) - (a.warmth_score ?? 0));
        } else if (sortField === "response") {
          merged.sort((a, b) => b.response_rate - a.response_rate);
        } else if (sortField === "last-contacted") {
          merged.sort((a, b) => {
            const aTime = a.last_contacted_at ? new Date(a.last_contacted_at).getTime() : 0;
            const bTime = b.last_contacted_at ? new Date(b.last_contacted_at).getTime() : 0;
            return bTime - aTime;
          });
        }

        // Limit after filter/sort
        const limited = merged.slice(0, parseInt(opts.limit));

        if (opts.json) {
          out.json({ contacts: limited, total: count });
          return;
        }

        out.table(
          ["Name", "Outlet", "Warmth", "Response", "Status", "Last Contact", "Confidence"],
          limited.map((c) => [
            out.truncate(c.name, 22),
            out.truncate(c.outlet, 16) || "\u2014",
            out.warmthBadge(c.warmth_level),
            c.response_rate > 0 ? percentage(c.response_rate) : chalk.dim("\u2014"),
            c.pipeline_status || "new",
            relativeDate(c.last_contacted_at),
            out.confidenceBadge(c.enrichment_confidence),
          ]),
        );

        out.info(`${limited.length} of ${count || 0} contacts${opts.warm ? " (warm/hot only)" : ""}`);
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
    .command("history")
    .description("Show cross-campaign timeline for a contact")
    .argument("<id-or-email>", "Contact ID or email address")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("-l, --limit <n>", "Max events", "50")
    .option("--json", "Output as JSON")
    .action(async (idOrEmail, opts) => {
      await showHistory(idOrEmail, opts);
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

  return cmd;
}
