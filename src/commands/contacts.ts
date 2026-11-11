/**
 * Contact commands for the TAP CLI.
 */

import { Command } from "commander";
import chalk from "chalk";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import { field, fieldList, sectionHeader, relativeDate, navHint, shortDate, ansiPadEnd, campaignLabel } from "../ui/detail.js";
import { handleError } from "../ui/errors.js";
import { blank } from "../ui/format.js";

/**
 * Show full contact detail view.
 * Exported so interactive mode can call it directly.
 */
export async function showContact(
  contactId: string,
  opts: { json?: boolean },
): Promise<void> {
  const spinner = out.spinner("Loading contact...");

  try {
    const resolvedId = await resolveContactId(contactId);
    if (!resolvedId) {
      spinner.stop();
      out.error(`No contact found with email: ${contactId}`);
      process.exit(1);
    }

    const contactRes = await restRequest<{ contact: any }>(`/api/v1/contacts/${encodeURIComponent(resolvedId)}`);
    const outcomesRes = await restRequest<{ outcomes: any[] }>("/api/v1/outcomes", {
      query: { contact_id: resolvedId, limit: 10 },
    });

    spinner.stop();
    const contact = contactRes.contact;
    const outcomes = outcomesRes.outcomes || [];

    if (opts.json) {
      out.json({ contact, outcomes });
      return;
    }

    console.log("");
    console.log(`  ${chalk.bold(contact.name || contact.email)}`);
    const headerParts = [
      contact.outlet,
      contact.role,
      contact.email,
    ].filter(Boolean);
    console.log(`  ${chalk.dim(headerParts.join("  ·  "))}`);
    console.log(chalk.dim(`  ${"\u2500".repeat(52)}`));

    // Intelligence
    sectionHeader("Intelligence");
    console.log(field("Platform", contact.platform_type));
    console.log(fieldList("Genres", contact.genres));
    console.log(field("Best timing", contact.best_timing));
    console.log(field("Enriched", relativeDate(contact.enriched_at)));

    // Recent outcomes
    if (outcomes.length > 0) {
      sectionHeader("Recent Outcomes", `${outcomes.length}`);
      for (const o of outcomes) {
        console.log(
          `  ${ansiPadEnd(out.pitchStatusBadge(o.outcome_type) || "", 14)}  ${shortDate(o.occurred_at)}`,
        );
        if (o.notes) {
          console.log(`    ${chalk.dim(`"${out.truncate(o.notes, 50)}"`)}`);
        }
      }
    }

    navHint([`tap contacts show ${contact.id.slice(0, 8)}`]);
    console.log("");
  } catch (err) {
    spinner.stop();
    handleError(err);
    process.exit(1);
  }
}

interface HistoryOutcome {
  id: string;
  campaign_id: string | null;
  outcome_type: string;
  notes: string | null;
  occurred_at: string | null;
}

interface TimelineEvent {
  date: string;
  type: string;
  campaign: string;
  detail: string | null;
}

async function resolveContactId(idOrEmail: string): Promise<string | null> {
  if (!idOrEmail.includes("@")) return idOrEmail;
  const email = idOrEmail.toLowerCase().trim();
  const { contacts } = await restRequest<{ contacts: Array<{ id: string; email: string }> }>(
    "/api/v1/contacts",
    { query: { search: email } },
  );
  return contacts.find((c) => c.email.toLowerCase() === email)?.id ?? null;
}

async function campaignNames(): Promise<Map<string, string>> {
  const { campaigns } = await restRequest<{
    campaigns: Array<{ id: string; name: string; artist_name: string | null }>;
  }>("/api/v1/campaigns", { query: { limit: 200 } });
  return new Map(campaigns.map((c) => [c.id, campaignLabel(c)]));
}

function toTimeline(outcomes: HistoryOutcome[], names: Map<string, string>): TimelineEvent[] {
  return outcomes.map((o) => ({
    date: o.occurred_at || "",
    type: o.outcome_type,
    campaign: (o.campaign_id && names.get(o.campaign_id)) || "",
    detail: o.notes,
  }));
}

function renderTimeline(
  contact: { name: string | null; email: string; outlet: string | null },
  events: TimelineEvent[],
): void {
  console.log("");
  console.log(
    `  ${chalk.bold(contact.name || contact.email)}${contact.outlet ? chalk.dim(` -- ${contact.outlet}`) : ""}`,
  );
  console.log(`  ${chalk.dim(`Timeline (${events.length} events)`)}`);
  console.log(chalk.dim(`  ${"\u2500".repeat(52)}`));
  console.log("");

  if (events.length === 0) {
    out.info("No history found for this contact");
    return;
  }

  const uniqueCampaigns = new Set(events.map((e) => e.campaign).filter(Boolean));
  for (const e of events) {
    console.log(
      `  ${shortDate(e.date).padEnd(8)}${ansiPadEnd(out.pitchStatusBadge(e.type) || "", 14)}  ${chalk.dim(out.truncate(e.campaign, 30) || "")}`,
    );
    if (e.detail) {
      console.log(`           ${chalk.dim(out.truncate(e.detail, 50))}`);
    }
  }
  console.log(chalk.dim(`  ${"\u2500".repeat(52)}`));
  console.log(
    chalk.dim(`  ${events.length} events across ${uniqueCampaigns.size} campaign${uniqueCampaigns.size === 1 ? "" : "s"}`),
  );
}

/**
 * Show cross-campaign outcome timeline for a contact.
 * Exported so interactive mode can call it directly.
 */
export async function showHistory(
  contactId: string,
  opts: { limit?: string; json?: boolean },
): Promise<void> {
  const spinner = out.spinner("Loading history...");

  try {
    const resolvedId = await resolveContactId(contactId);
    if (!resolvedId) {
      spinner.stop();
      out.error(`No contact found with email: ${contactId}`);
      process.exit(1);
    }

    const [{ contact }, { outcomes }, names] = await Promise.all([
      restRequest<{ contact: { id: string; name: string | null; email: string; outlet: string | null } }>(
        `/api/v1/contacts/${encodeURIComponent(resolvedId)}`,
      ),
      restRequest<{ outcomes: HistoryOutcome[] }>("/api/v1/outcomes", {
        query: { contact_id: resolvedId, limit: parseInt(opts.limit || "50") },
      }),
      campaignNames(),
    ]);
    spinner.stop();

    const events = toTimeline(outcomes, names);
    if (opts.json) {
      out.json({ contact, events });
      return;
    }

    renderTimeline(contact, events);
    navHint([`tap contacts show ${contact.id.slice(0, 8)}`]);
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
        const res = await restRequest<{ contacts: any[]; total: number }>("/api/v1/contacts", {
          query: {
            limit: parseInt(opts.limit) || 50,
          },
        });

        // In-memory filter for status, genre, bbc
        let contacts = res.contacts;
        if (opts.status) {
          contacts = contacts.filter(c => c.pipeline_status === opts.status);
        }
        if (opts.genre) {
          contacts = contacts.filter(c => c.genres?.includes(opts.genre));
        }
        if (opts.bbc) {
          contacts = contacts.filter(c => c.bbc_station != null);
        }

        spinner.stop();

        if (opts.json) {
          out.json(contacts);
          return;
        }

        if (contacts.length === 0) {
          out.info("No contacts found");
          return;
        }

        out.table(
          ["Name", "Email", "Outlet", "Warmth", "Confidence"],
          contacts.map((c) => [
            out.truncate(c.name, 22),
            out.truncate(c.email, 28),
            out.truncate(c.outlet, 18) || "\u2014",
            out.warmthBadge(null),
            out.confidenceBadge(c.enrichment_confidence),
          ]),
        );

        out.info(`${contacts.length} results`);
        navHint(["tap contacts show <id>"]);
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
    .option("--json", "Output as JSON")
    .action(async (idOrEmail, opts) => {
      await showContact(idOrEmail, opts);
    });

  cmd
    .command("history")
    .description("Show cross-campaign timeline for a contact")
    .argument("<id-or-email>", "Contact ID or email address")
    .option("-l, --limit <n>", "Max events", "50")
    .option("--json", "Output as JSON")
    .action(async (idOrEmail, opts) => {
      await showHistory(idOrEmail, opts);
    });

  cmd
    .command("search")
    .description("Search contacts")
    .argument("<query>", "Search query")
    .option("--json", "Output as JSON")
    .action(async (query, opts) => {
      const spinner = out.spinner("Searching...");

      try {
        const res = await restRequest<{ contacts: any[]; total: number }>("/api/v1/contacts", {
          query: {
            search: query,
            limit: 20,
          },
        });

        spinner.stop();

        if (opts.json) {
          out.json(res.contacts);
          return;
        }

        if (res.contacts.length === 0) {
          out.info(`No contacts matching "${query}"`);
          return;
        }

        out.table(
          ["Name", "Email", "Outlet", "Warmth", "Confidence"],
          res.contacts.map((c) => [
            out.truncate(c.name, 22),
            out.truncate(c.email, 28),
            out.truncate(c.outlet, 18) || "\u2014",
            out.warmthBadge(null),
            out.confidenceBadge(c.enrichment_confidence),
          ]),
        );

        out.info(`${res.contacts.length} results`);
        navHint(["tap contacts show <id>"]);
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
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const spinner = out.spinner("Adding contact...");

      try {
        const res = await restRequest<{
          imported: number;
          results: Array<{ email: string; status: string; reason?: string }>;
        }>('/api/v1/contacts', {
          method: 'POST',
          body: {
            contacts: [
              {
                name: opts.name,
                email: opts.email.toLowerCase().trim(),
                outlet: opts.outlet,
                role: opts.role,
                platform_type: opts.platform,
                genres: opts.genre ? opts.genre.split(",").map((g: string) => g.trim()) : undefined,
                bbc_station: opts.bbcStation,
              },
            ],
          },
        });

        if (res.imported === 0) {
          spinner.stop();
          const reason = res.results?.[0]?.reason || 'unknown';
          out.error(`Failed to create contact: ${reason}`);
          process.exit(1);
        }

        // Search to retrieve the generated ID
        const searchRes = await restRequest<{ contacts: Array<{ id: string; name: string; email: string }> }>('/api/v1/contacts', {
          query: { search: opts.email },
        });

        const created = searchRes.contacts.find(c => c.email.toLowerCase() === opts.email.toLowerCase().trim());
        spinner.stop();

        if (opts.json) {
          out.json(created || { name: opts.name, email: opts.email });
          return;
        }

        out.success(`Added ${opts.name} <${opts.email}>`);
        if (created) {
          out.info(`ID: ${created.id}`);
          navHint([
            `tap contacts show ${created.id.slice(0, 8)}`,
          ]);
        }
        blank();
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });

  cmd
    .command("enrich")
    .description("Enrich a contact with AI (uses one monthly enrichment)")
    .argument("<id>", "Contact ID")
    .action(async (id) => {
      const spinner = out.spinner("Enriching contact...");

      try {
        const res = await restRequest<{
          enriched: number;
          creditsRemaining: number;
          results: Array<{ contactId: string; status: string; error?: string }>;
        }>("/api/v1/contacts/enrich", { method: "POST", body: { contactIds: [id] } });
        spinner.stop();

        const result = res.results[0];
        if (result?.status === "enriched") {
          out.success(`Contact ${id.slice(0, 8)} enriched`);
        } else {
          out.warn(`Contact ${id.slice(0, 8)} ${result?.status ?? "not enriched"}${result?.error ? `: ${result.error}` : ""}`);
        }
        out.info(`${res.creditsRemaining} enrichments left this month`);
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });

  return cmd;
}
