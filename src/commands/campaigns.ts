/**
 * Campaign commands for the TAP CLI.
 */

import { Command } from "commander";
import chalk from "chalk";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import { GLYPH, COLOUR } from "../ui/theme.js";
import { sectionHeader, sparkbar, shortDate, navHint, ansiPadEnd } from "../ui/detail.js";
import { handleError } from "../ui/errors.js";
import { blank } from "../ui/format.js";

/**
 * Show full campaign detail view with health metrics and coverage.
 */
async function showCampaign(
  id: string,
  opts: { json?: boolean },
): Promise<void> {
  const spinner = out.spinner("Loading campaign...");

  try {
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
    const releaseDate = campaign.release_date
      ? new Date(campaign.release_date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
      : null;
    const facts: Array<[string, string | null]> = [
      ["Artist", campaign.artist_name],
      ["Release", campaign.release_title],
      ["Date", releaseDate],
      ["Goal", campaign.goal],
    ];
    for (const [label, value] of facts) {
      if (value) console.log(`  ${chalk.dim(label.padEnd(9))}${value}`);
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

    navHint([`tap send ${campaign.id}`, `tap open ${campaign.id}`]);
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
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  tap campaigns list
  tap campaigns list --status active
  tap campaigns list --json`)
    .action(async (opts) => {
      const spinner = out.spinner("Fetching campaigns...");

      try {
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
          ["Name", "Artist", "Status", "Release", "Contacts"],
          res.campaigns.map((c) => [
            out.truncate(c.name, 28),
            out.truncate(c.artist_name, 18) || "—",
            out.statusBadge(c.status),
            c.release_date || "—",
            String(c.contact_count ?? 0),
          ]),
        );

        out.info(`${res.campaigns.length} campaign${res.campaigns.length === 1 ? "" : "s"}`);
        navHint(["tap campaigns show <id>", "tap queue"]);
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
    .action(async (opts) => {
      const spinner = out.spinner("Creating campaign...");

      try {
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
          `tap campaigns show ${res.campaign.id}`,
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
        await restRequest(`/api/v1/campaigns/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { status },
        });

        spinner.stop();
        out.success(`Campaign ${id} ${GLYPH.arrow} ${out.statusBadge(status)}`);
      } catch (err) {
        spinner.stop();
        handleError(err);
        process.exit(1);
      }
    });

  return cmd;
}
