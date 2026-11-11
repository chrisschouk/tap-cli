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
import { COLOUR, GLYPH } from "../ui/theme.js";

/**
 * Show full contact detail view.
 */
async function showContact(
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

    navHint([`tap contacts history ${contact.id}`]);
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
 */
async function showHistory(
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
    navHint([`tap contacts show ${contact.id}`]);
    console.log("");
  } catch (err) {
    spinner.stop();
    handleError(err);
    process.exit(1);
  }
}

/** `GET /api/v1/contacts` answers these fields only (apps/tap/app/api/v1/contacts/route.ts). */
interface ContactListRow {
  id: string;
  name: string | null;
  email: string;
  outlet: string | null;
  platform_type: string | null;
  enriched: boolean | null;
}

interface ContactPage {
  contacts: ContactListRow[];
  total: number;
  page: number;
  limit: number;
}

function renderContactPage(res: ContactPage, emptyMessage: string): void {
  if (res.contacts.length === 0) {
    out.info(res.total > 0 ? `Page ${res.page} is past the last of ${res.total} contacts` : emptyMessage);
    return;
  }

  out.table(
    ["Name", "Email", "Outlet", "Platform", "Enriched"],
    res.contacts.map((c) => [
      out.truncate(c.name, 22),
      out.truncate(c.email, 30),
      out.truncate(c.outlet, 20) || "\u2014",
      c.platform_type || "\u2014",
      c.enriched ? chalk.hex(COLOUR.success)(GLYPH.check) : chalk.dim(GLYPH.dot),
    ]),
  );

  const first = (res.page - 1) * res.limit + 1;
  const last = first + res.contacts.length - 1;
  blank();
  out.info(`${first}\u2013${last} of ${res.total} contacts`);
  const hints = ["tap contacts show <id-or-email>"];
  if (last < res.total) hints.push(`--page ${res.page + 1} for more`);
  navHint(hints);
  blank();
}

export function contactsCommand(): Command {
  const cmd = new Command("contacts").description("Manage contacts");

  cmd
    .command("list")
    .description("List contacts, newest first")
    .option("--platform <type>", "Only this platform type (radio, press, playlist, podcast, blog)")
    .option("-l, --limit <n>", "Contacts per page, up to 200", "50")
    .option("-p, --page <number>", "Page number", "1")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  tap contacts list --platform radio
  tap contacts list -l 200 --page 2`)
    .action(async (opts) => {
      const spinner = out.spinner("Fetching contacts...");

      try {
        const res = await restRequest<ContactPage>("/api/v1/contacts", {
          query: {
            limit: parseInt(opts.limit) || 50,
            page: parseInt(opts.page) || 1,
            platform_type: opts.platform,
          },
        });
        spinner.stop();

        if (opts.json) {
          out.json(res.contacts);
          return;
        }
        renderContactPage(res, "No contacts found");
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
        const res = await restRequest<ContactPage>("/api/v1/contacts", {
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

        renderContactPage(res, `No contacts matching "${query}"`);
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
            `tap contacts show ${created.id}`,
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
          creditsRemaining: number | null;
          results: Array<{ contactId: string; status: string; error?: string }>;
        }>("/api/v1/contacts/enrich", { method: "POST", body: { contactIds: [id] } });
        spinner.stop();

        const result = res.results[0];
        if (result?.status === "enriched") {
          out.success(`Contact ${id} enriched`);
        } else {
          out.warn(`Contact ${id} ${result?.status ?? "not enriched"}${result?.error ? `: ${result.error}` : ""}`);
        }
        out.info(
          res.creditsRemaining === null
            ? "Unlimited enrichments on your plan"
            : `${res.creditsRemaining} enrichments left this month`,
        );
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });

  return cmd;
}
