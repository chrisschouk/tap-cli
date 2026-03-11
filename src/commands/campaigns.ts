/**
 * Campaign commands for the TAP CLI.
 */

import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import { GLYPH, COLOUR } from "../ui/theme.js";

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
      const spinner = ora("Fetching campaigns...").start();

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
    .description("Show campaign details with contacts")
    .argument("<id>", "Campaign ID")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
      const spinner = ora("Loading campaign...").start();

      try {
        const supabase = getClient();

        // Fetch campaign
        const { data: campaign, error: campErr } = await supabase
          .from("tap_projects")
          .select(
            "id, name, artist_name, status, release_name, release_date, goal, created_at",
          )
          .eq("id", id)
          .single();

        if (campErr || !campaign) {
          spinner.stop();
          out.error(campErr?.message || `Campaign not found: ${id}`);
          process.exit(1);
        }

        // Fetch campaign contacts with contact details
        const { data: contacts, error: contactErr } = await supabase
          .from("campaign_contacts")
          .select(
            "pitch_status, last_pitched_at, contact_id, tap_contacts(id, name, email, outlet, warmth, engagement_score)",
          )
          .eq("project_id", id)
          .order("last_pitched_at", { ascending: false, nullsFirst: false });

        spinner.stop();

        if (contactErr) {
          out.error(contactErr.message);
          process.exit(1);
        }

        if (opts.json) {
          out.json({ campaign, contacts });
          return;
        }

        // Campaign header
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
          const d = new Date(campaign.release_date).toLocaleDateString(
            "en-GB",
            {
              day: "numeric",
              month: "long",
              year: "numeric",
            },
          );
          console.log(`  ${chalk.dim("Date")}    ${d}`);
        }
        if (campaign.goal) {
          console.log(`  ${chalk.dim("Goal")}    ${campaign.goal}`);
        }
        console.log("");

        if (!contacts || contacts.length === 0) {
          out.info("No contacts assigned to this campaign");
          return;
        }

        // Contact table
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = (contacts as any[])
          .filter((c: any) => c.tap_contacts) // eslint-disable-line @typescript-eslint/no-explicit-any
          .map((c: any) => {
            // eslint-disable-line @typescript-eslint/no-explicit-any
            const contact = Array.isArray(c.tap_contacts)
              ? c.tap_contacts[0]
              : c.tap_contacts;
            const lastPitched = c.last_pitched_at
              ? new Date(c.last_pitched_at).toLocaleDateString("en-GB")
              : "\u2014";
            const engagement = contact.engagement_score
              ? `${contact.engagement_score}`
              : "\u2014";

            return [
              out.truncate(contact.name, 22),
              out.truncate(contact.outlet, 18) || "\u2014",
              out.pitchStatusBadge(c.pitch_status),
              lastPitched,
              engagement,
            ];
          });

        out.table(
          ["Name", "Outlet", "Pitch Status", "Last Pitched", "Engagement"],
          rows,
        );
        console.log("");

        // Summary stats
        const total = contacts.length;
        const pitched = contacts.filter(
          (c) => c.pitch_status && c.pitch_status !== "not_pitched",
        ).length;
        const replied = contacts.filter(
          (c) => c.pitch_status === "replied",
        ).length;

        const pctPitched = total > 0 ? Math.round((pitched / total) * 100) : 0;
        const pctReplied =
          pitched > 0 ? Math.round((replied / pitched) * 100) : 0;

        console.log(
          `  ${chalk.dim("Contacts")} ${total}  ${chalk.dim(GLYPH.dot)}  ` +
            `${chalk.dim("Pitched")} ${chalk.hex(COLOUR.primary)(`${pctPitched}%`)}  ${chalk.dim(GLYPH.dot)}  ` +
            `${chalk.dim("Reply rate")} ${chalk.hex(COLOUR.success)(`${pctReplied}%`)}`,
        );
        console.log("");
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
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
      const spinner = ora("Creating campaign...").start();

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

      const spinner = ora("Updating status...").start();

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
