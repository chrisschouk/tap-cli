/**
 * Contact commands for the TAP CLI.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import {
  fetchContactFull,
  fetchContactMetrics,
  fetchContactOutcomes,
  fetchContactCampaigns,
  fetchContactCoverage,
  resolveContactByEmail,
  type ContactFull,
  type ContactOutcome,
  type ContactCoverage,
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
  ansiPadEnd,
  campaignLabel,
} from "../ui/detail.js";
import { handleError } from "../ui/errors.js";
import { blank } from "../ui/format.js";
import { runCommand } from "../ui/run-command.js";

/**
 * Escape a search query for safe use in PostgREST .or() ILIKE filters.
 * Prevents filter injection via SQL wildcard and PostgREST syntax characters.
 */
function escapePostgrestSearch(query: string): string {
  return query
    .replace(/\\/g, "\\\\") // Backslash must come first
    .replace(/'/g, "''") // SQL single quotes
    .replace(/%/g, "\\%") // ILIKE wildcard
    .replace(/_/g, "\\_"); // ILIKE wildcard
}

function renderIntelligence(contact: ContactFull, interactive = false): void {
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
    console.log(field("Guidelines", out.truncate(contact.submission_guidelines, 60)));
  }
  if (contact.pitch_tips && contact.pitch_tips.length > 0) {
    console.log(field("Pitch tips", ""));
    for (const tip of contact.pitch_tips) {
      console.log(`${"".padEnd(20)}${chalk.dim(".")} ${tip}`);
    }
  }
  if (interactive) {
    console.log(field("Confidence", contact.enrichment_confidence, {
      colour: warmthColour(
        contact.enrichment_confidence === "High" ? "warm" :
        contact.enrichment_confidence === "Medium" ? "neutral" : "cold",
      ),
    }));
  } else {
    console.log(field("Confidence", contact.enrichment_confidence));
  }
  console.log(field("Enriched", relativeDate(contact.enriched_at)));
}

function renderOutcomes(outcomes: ContactOutcome[]): void {
  sectionHeader("Recent Outcomes", `${outcomes.length}`);
  for (const o of outcomes) {
    const campaign = o.artist_name
      ? `${o.artist_name} -- ${o.project_name}`
      : o.project_name || "";
    console.log(
      `  ${ansiPadEnd(out.pitchStatusBadge(o.outcome_type) || "", 14)}  ${(out.truncate(campaign, 28) || "").padEnd(28)}  ${shortDate(o.occurred_at)}`,
    );
    if (o.notes) {
      console.log(`${"".padEnd(4)}${chalk.dim(`"${out.truncate(o.notes, 50)}"`)}`);
    }
  }
}

function renderCoverage(coverage: ContactCoverage[]): void {
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

/**
 * Show full contact detail view.
 * Exported so interactive mode can call it directly.
 */
export async function showContact(
  contactId: string,
  opts: { workspace?: string; json?: boolean },
): Promise<void> {
  const spinner = out.spinner("Loading contact...");

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
    const headerParts = [
      contact.outlet,
      contact.role,
      contact.email,
    ].filter(Boolean);
    console.log(`  ${chalk.dim(headerParts.join("  ·  "))}`);
    console.log(chalk.dim(`  ${"\u2500".repeat(52)}`));

    // -- Relationship (always shown) --
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

    // -- Campaigns (compact: max 3) --
    if (campaigns.length > 0) {
      sectionHeader("Campaigns", `${campaigns.length}`);
      const shown = campaigns.slice(0, 3);
      for (const c of shown) {
        const label = c.artist_name
          ? `${c.artist_name} -- ${c.project_name}`
          : c.project_name;
        console.log(
          `  ${(out.truncate(label, 32) || "").padEnd(32)}  ${ansiPadEnd(out.pitchStatusBadge(c.pitch_status) || "", 14)}  ${shortDate(c.last_pitched_at)}`,
        );
      }
      if (campaigns.length > 3) {
        console.log(chalk.dim(`  +${campaigns.length - 3} more`));
      }
    }

    // -- Warnings (always shown) --
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

    // -- Progressive disclosure + actions (TTY only) --
    const hasIntel =
      contact.platform_type ||
      contact.genres?.length ||
      contact.geographic_scope ||
      contact.best_timing ||
      contact.bbc_station ||
      contact.submission_guidelines ||
      contact.pitch_tips?.length;

    if (process.stdout.isTTY) {
      while (true) {
        const drillOptions: Array<{ value: string; label: string; hint?: string }> = [];

        // Viewing options
        if (hasIntel) drillOptions.push({ value: "intel", label: "Intelligence details", hint: contact.enrichment_confidence || undefined });
        if (outcomes.length > 0) drillOptions.push({ value: "outcomes", label: "Outcomes", hint: `${outcomes.length}` });
        if (coverage.length > 0) drillOptions.push({ value: "coverage", label: "Coverage", hint: `${coverage.length}` });
        if (campaigns.length > 3) drillOptions.push({ value: "campaigns", label: "All campaigns", hint: `${campaigns.length}` });

        // Inlined action options (no sub-menu)
        drillOptions.push({ value: "pitch", label: "Pitch", hint: "generate AI draft" });
        drillOptions.push({ value: "log-outcome", label: "Log outcome" });
        drillOptions.push({ value: "enrich", label: "Enrich", hint: "queue AI enrichment" });
        drillOptions.push({ value: "open", label: "Open in browser" });
        drillOptions.push({ value: "done", label: chalk.dim("Done") });

        const drill = (await prompts.select({
          message: "What next?",
          options: drillOptions,
        })) as string | symbol;

        if (prompts.isCancel(drill) || drill === "done") break;

        if (drill === "intel") {
          renderIntelligence(contact, true);
        } else if (drill === "outcomes") {
          renderOutcomes(outcomes);
        } else if (drill === "coverage") {
          renderCoverage(coverage);
        } else if (drill === "campaigns") {
          sectionHeader("All Campaigns", `${campaigns.length}`);
          for (const c of campaigns) {
            const label = c.artist_name
              ? `${c.artist_name} -- ${c.project_name}`
              : c.project_name;
            console.log(
              `  ${(out.truncate(label, 32) || "").padEnd(32)}  ${ansiPadEnd(out.pitchStatusBadge(c.pitch_status) || "", 14)}  ${shortDate(c.last_pitched_at)}`,
            );
          }
        } else if (drill === "pitch" || drill === "log-outcome" || drill === "enrich" || drill === "open") {
          const supabase = getClient();
          const wsId = await resolveWorkspaceId(supabase, opts.workspace);
          if (drill === "pitch") {
            const { selectCampaign } = await import("../ui/actions.js");
            const campaignId = await selectCampaign(supabase, wsId, { statusFilter: "active", message: "Which campaign?" });
            if (campaignId) {
              await runCommand(["pitch", campaignId, contact.id]);
            }
            continue;
          } else if (drill === "log-outcome") {
            const { selectCampaign, outcomePrompt } = await import("../ui/actions.js");
            const campaignId = await selectCampaign(supabase, wsId, { message: "Which campaign?" });
            if (campaignId) {
              await outcomePrompt(supabase, wsId, campaignId, contact.id);
            }
            continue;
          } else if (drill === "enrich") {
            const spinner2 = out.spinner("Queueing enrichment...");
            const { error: enrichErr } = await supabase
              .from("tap_contacts")
              .update({ enrichment_source: "queued" })
              .eq("id", contact.id);
            spinner2.stop();
            if (enrichErr) out.error(enrichErr.message);
            else out.success(`Contact ${contact.id.slice(0, 8)} queued for enrichment`);
            continue;
          } else if (drill === "open") {
            await runCommand(["open", contact.id]);
            break;
          }
        }
      }
    } else {
      // Non-interactive: dump everything
      if (hasIntel) renderIntelligence(contact);
      if (outcomes.length > 0) renderOutcomes(outcomes);
      if (coverage.length > 0) renderCoverage(coverage);
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
    handleError(err);
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
  const spinner = out.spinner("Loading history...");

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
      const campaign = project ? campaignLabel(project) : "";
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
        const campaign = project ? campaignLabel(project) : "";
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
    console.log(chalk.dim(`  ${"\u2500".repeat(52)}`));
    console.log("");

    if (limited.length === 0) {
      out.info("No history found for this contact");
    } else {
      // Unique campaigns for summary
      const uniqueCampaigns = new Set(limited.map((e) => e.campaign).filter(Boolean));

      for (const e of limited) {
        const dateStr = shortDate(e.date);
        console.log(
          `  ${dateStr.padEnd(8)}${ansiPadEnd(out.pitchStatusBadge(e.type) || "", 14)}  ${chalk.dim(out.truncate(e.campaign, 30) || "")}`,
        );
        if (e.detail) {
          console.log(`           ${chalk.dim(out.truncate(e.detail, 50))}`);
        }
      }

      console.log(chalk.dim(`  ${"\u2500".repeat(52)}`));
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
    handleError(err);
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
    .option("-p, --page <number>", "Page number", "1")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  tap contacts list --warm --sort warmth
  tap contacts list --bbc --sort response
  tap contacts list --genre electronic -l 20
  tap contacts list --page 2`)
    .action(async (opts) => {
      const spinner = out.spinner("Fetching contacts...");

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        const page = parseInt(opts.page) || 1;
        const limit = opts.warm ? 500 : parseInt(opts.limit) || 50;
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        // Fetch contacts
        let query = supabase
          .from("tap_contacts")
          .select(
            "id, name, email, outlet, pipeline_status, enrichment_confidence, last_contacted_at",
            { count: "exact" },
          )
          .eq("workspace_id", wsId)
          .order("name", { ascending: true })
          .range(from, to);

        if (opts.status) query = query.eq("pipeline_status", opts.status);
        if (opts.genre) query = query.contains("genres", [opts.genre]);
        if (opts.bbc) query = query.not("bbc_station", "is", null);

        // Fetch contacts first, then metrics for only those contact IDs
        const contactResult = await query;

        spinner.stop();

        const { data, count, error } = contactResult;

        // Fetch metrics only for the contacts in this page
        let metricsResult: { data: Array<{ contact_id: string; warmth_level: string | null; warmth_score: number | null; response_rate: number }> | null } = { data: null };
        if (data && data.length > 0) {
          const contactIds = data.map((c) => c.id);
          // Batch in groups of 200 to stay within PostgREST URL limits
          const batches = [];
          for (let i = 0; i < contactIds.length; i += 200) {
            batches.push(contactIds.slice(i, i + 200));
          }
          const batchResults = await Promise.all(
            batches.map((batch) =>
              supabase
                .from("contact_relationship_metrics")
                .select("contact_id, warmth_level, warmth_score, response_rate")
                .in("contact_id", batch),
            ),
          );
          metricsResult = {
            data: batchResults.flatMap((r) => r.data || []),
          };
        }

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

        if (opts.json) {
          out.json({ contacts: merged, total: count, page, limit });
          return;
        }

        out.table(
          ["Name", "Outlet", "Warmth", "Response", "Status", "Last Contact", "Confidence"],
          merged.map((c) => [
            out.truncate(c.name, 22),
            out.truncate(c.outlet, 16) || "\u2014",
            out.warmthBadge(c.warmth_level),
            c.response_rate > 0 ? percentage(c.response_rate) : chalk.dim("\u2014"),
            c.pipeline_status || "new",
            relativeDate(c.last_contacted_at),
            out.confidenceBadge(c.enrichment_confidence),
          ]),
        );

        const totalCount = count || 0;
        const totalPages = Math.ceil(totalCount / limit);
        console.log(chalk.dim(`  Page ${page} of ${totalPages} (${totalCount} contacts${opts.warm ? ", warm/hot only" : ""})`));
        if (page < totalPages) {
          const nextArgs = [`--page ${page + 1}`, opts.limit !== "50" ? `-l ${opts.limit}` : ""].filter(Boolean).join(" ");
          console.log(chalk.dim(`  Next: tap contacts list ${nextArgs}`));
        }

        navHint([
          "tap contacts show <id>",
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
      const spinner = out.spinner("Searching...");

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);
        const q = escapePostgrestSearch(query);

        const searchResult = await supabase
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

        const { data, error } = searchResult;

        // Fetch metrics only for the contacts returned
        let metricsResult: { data: Array<{ contact_id: string; warmth_level: string | null }> | null } = { data: null };
        if (data && data.length > 0) {
          const contactIds = data.map((c) => c.id);
          metricsResult = await supabase
            .from("contact_relationship_metrics")
            .select("contact_id, warmth_level")
            .in("contact_id", contactIds);
        }

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

        // Build warmth lookup
        const warmthMap = new Map<string, string>();
        if (metricsResult.data) {
          for (const m of metricsResult.data) {
            if (m.warmth_level) warmthMap.set(m.contact_id, m.warmth_level);
          }
        }

        out.table(
          ["Name", "Email", "Outlet", "Warmth", "Confidence"],
          data.map((c) => [
            out.truncate(c.name, 22),
            out.truncate(c.email, 28),
            out.truncate(c.outlet, 18) || "\u2014",
            out.warmthBadge(warmthMap.get(c.id) || null),
            out.confidenceBadge(c.enrichment_confidence),
          ]),
        );

        out.info(`${data.length} results`);

        navHint([
          "tap contacts show <id>",
          "tap contacts add --name \"...\" --email \"...\"",
        ]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
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
      const spinner = out.spinner("Adding contact...");

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

        navHint([
          `tap contacts show ${data.id.slice(0, 8)}`,
          `tap contacts enrich ${data.id.slice(0, 8)}`,
        ]);
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });

  cmd
    .command("enrich")
    .description("Queue a contact for AI enrichment")
    .argument("<id>", "Contact ID")
    .action(async (id) => {
      const spinner = out.spinner("Queueing enrichment...");

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
        handleError(err);
        process.exit(1);
      }
    });

  return cmd;
}
