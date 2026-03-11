/**
 * Discover command -- AI-powered contact discovery from terminal.
 *
 * Uses Perplexity sonar-pro to find radio/press contacts by station,
 * genre, or region. Deduplicates against existing TAP contacts.
 *
 * Usage:
 *   tap discover "BBC Radio 6 Music"
 *   tap discover --genre electronic --region london
 *   tap discover --station "Kiss FM" --genre dance
 */

import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { getClient, resolveWorkspaceId, loadConfig } from "../auth.js";
import * as out from "../output.js";
import { GLYPH } from "../ui/theme.js";
import { sectionHeader, percentage } from "../ui/detail.js";
import { discoverContacts, deduplicateContacts } from "../lib/discover.js";

function getPerplexityKey(): string | null {
  // Check env var
  if (process.env.PERPLEXITY_API_KEY) return process.env.PERPLEXITY_API_KEY;

  // Check config file
  const config = loadConfig();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perplexityKey = (config as any)?.perplexityKey;
  if (perplexityKey) return perplexityKey;

  return null;
}

export function discoverCommand(): Command {
  return new Command("discover")
    .description("Discover new contacts using AI")
    .argument("[query]", "Freetext search query")
    .option("--genre <genre>", "Filter by genre")
    .option("--region <region>", "Filter by region")
    .option("--station <name>", "Specific station lookup")
    .option("--import", "Auto-import all without prompting")
    .option("--enrich", "Queue imported contacts for enrichment")
    .option("-l, --limit <n>", "Max results", "10")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Structured output")
    .action(async (query, opts) => {
      const apiKey = getPerplexityKey();
      if (!apiKey) {
        out.error(
          "PERPLEXITY_API_KEY required. Set it in environment or add perplexityKey to ~/.tap/config.json",
        );
        process.exit(1);
      }

      if (!query && !opts.genre && !opts.region && !opts.station) {
        out.error(
          'Provide a search query or use --genre, --region, or --station flags.\n  Example: tap discover "BBC Radio 6 Music"',
        );
        process.exit(1);
      }

      const searchTerm =
        query || opts.station || `${opts.genre || ""} ${opts.region || ""}`.trim();
      const spinner = ora(
        `Discovering contacts for "${searchTerm}"...`,
      ).start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        const discovered = await discoverContacts(
          query || "",
          {
            genre: opts.genre,
            region: opts.region,
            station: opts.station,
            limit: parseInt(opts.limit),
          },
          apiKey,
        );

        if (discovered.length === 0) {
          spinner.stop();
          out.info("No contacts found. Try a different search.");
          return;
        }

        // Deduplicate against existing
        const { newContacts, existingContacts } = await deduplicateContacts(
          supabase,
          wsId,
          discovered,
        );

        spinner.stop();

        if (opts.json) {
          out.json({
            discovered: discovered.length,
            new: newContacts,
            existing: existingContacts,
          });
          return;
        }

        // Display header
        console.log("");
        console.log(
          `  Found ${chalk.bold(discovered.length)} contacts (${existingContacts.length} already in TAP)`,
        );

        // New contacts
        if (newContacts.length > 0) {
          sectionHeader("NEW");
          for (let i = 0; i < newContacts.length; i++) {
            const c = newContacts[i];
            const confBadge = out.confidenceBadge(
              c.confidence === "high"
                ? "High"
                : c.confidence === "medium"
                  ? "Medium"
                  : "Low",
            );
            console.log(
              `  ${chalk.dim(`${i + 1}.`)} ${chalk.bold(c.name)}${c.email ? `    ${chalk.dim(c.email)}` : ""}     ${c.role || ""}    ${confBadge}`,
            );
            if (c.source) {
              console.log(`     ${chalk.dim(`Source: ${c.source}`)}`);
            }
          }
        }

        // Existing contacts
        if (existingContacts.length > 0) {
          sectionHeader("ALREADY IN TAP");
          for (const c of existingContacts) {
            const warmth = c.warmth_level
              ? out.warmthBadge(c.warmth_level)
              : chalk.dim("--");
            const status = c.pipeline_status || "new";
            const response =
              c.response_rate > 0
                ? percentage(c.response_rate)
                : chalk.dim("--");
            console.log(
              `  ${chalk.dim(GLYPH.dot)} ${c.name.padEnd(20)}${warmth}  ${status.padEnd(12)}${response} response`,
            );
          }
        }

        // Import prompt
        if (newContacts.length === 0) {
          console.log("");
          out.info("All discovered contacts are already in TAP");
          return;
        }

        const importable = newContacts.filter((c) => c.email);

        if (importable.length === 0) {
          console.log("");
          out.warn("No new contacts have email addresses -- cannot import");
          return;
        }

        let toImport = importable;

        if (!opts.import) {
          console.log("");
          const shouldImport = await prompts.confirm({
            message: `Import ${importable.length} new contacts?`,
          });

          if (prompts.isCancel(shouldImport) || !shouldImport) {
            console.log(chalk.dim("  Skipped."));
            return;
          }
        }

        // Batch insert
        const insertSpinner = ora(
          `Importing ${toImport.length} contacts...`,
        ).start();

        const CHUNK_SIZE = 100;
        let imported = 0;

        for (let i = 0; i < toImport.length; i += CHUNK_SIZE) {
          const chunk = toImport.slice(i, i + CHUNK_SIZE);
          const rows = chunk.map((c) => ({
            workspace_id: wsId,
            name: c.name,
            email: c.email!.toLowerCase().trim(),
            outlet: c.outlet || null,
            role: c.role || null,
            source: "cli-discover",
            pipeline_status: "new",
            enrichment_confidence: c.confidence === "high" ? "High" : c.confidence === "medium" ? "Medium" : "Low",
          }));

          const { error } = await supabase
            .from("tap_contacts")
            .upsert(rows, { onConflict: "workspace_id,email", ignoreDuplicates: true });

          if (!error) {
            imported += chunk.length;
          }
        }

        // Queue for enrichment if requested
        if (opts.enrich && imported > 0) {
          const emails = toImport.map((c) => c.email!.toLowerCase().trim());
          await supabase
            .from("tap_contacts")
            .update({ enrichment_source: "queued" })
            .eq("workspace_id", wsId)
            .in("email", emails)
            .is("enriched_at", null);
        }

        insertSpinner.stop();

        out.success(`${imported} contacts imported`);
        if (opts.enrich) {
          out.success("Queued for enrichment");
        }
        console.log("");
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });
}
