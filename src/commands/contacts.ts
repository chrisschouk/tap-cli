/**
 * Contact commands for the TAP CLI.
 */

import { Command } from "commander";
import ora from "ora";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";

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
          // Handle duplicate email
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
