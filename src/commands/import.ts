/**
 * Import command -- sink-cli integration + CSV/JSON import.
 *
 * Usage:
 *   sink wash contacts.csv --json | tap import --stdin
 *   tap import enriched.json
 *   tap import contacts.csv
 *   tap import enriched.jsonl
 */

import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { readFileSync } from "node:fs";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import { GLYPH } from "../ui/theme.js";
import { sectionHeader } from "../ui/detail.js";
import {
  type SinkRecord,
  type TapContactInsert,
  mapSinkRecordToContact,
  filterImportable,
  detectSinkFormat,
  extractSinkRecords,
} from "../lib/sink-mapper.js";

interface PlainContact {
  name?: string;
  email?: string;
  outlet?: string;
  role?: string;
  [key: string]: unknown;
}

/**
 * Parse CSV text into plain objects.
 * Simple parser -- handles quoted fields but not escaped quotes within quotes.
 */
function parseCsv(text: string): PlainContact[] {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/['"]/g, ""));

  return lines.slice(1).map((line) => {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    const obj: PlainContact = {};
    for (let i = 0; i < headers.length; i++) {
      if (values[i]) obj[headers[i]] = values[i].replace(/^['"]|['"]$/g, "");
    }
    return obj;
  });
}

/**
 * Map plain JSON/CSV contact to TAP insert format.
 */
function mapPlainContact(
  c: PlainContact,
): { email: string; name: string | null; outlet: string | null; role: string | null } | null {
  const email = (c.email || c.Email || c["email address"] || c["e-mail"]) as string | undefined;
  if (!email || !email.includes("@")) return null;

  return {
    email: email.toLowerCase().trim(),
    name: (c.name || c.Name || c["full name"] || c["contact name"] || null) as string | null,
    outlet: (c.outlet || c.Outlet || c.station || c.Station || c.publication || null) as string | null,
    role: (c.role || c.Role || c.title || c.Title || null) as string | null,
  };
}

export function importCommand(): Command {
  return new Command("import")
    .description("Import contacts from sink-cli, CSV, or JSON")
    .argument("[file]", "File path (CSV, JSON, or JSONL)")
    .option("--stdin", "Read from stdin (for piping from sink)")
    .option("--yes", "Skip confirmation")
    .option("--dry-run", "Preview without importing")
    .option("--campaign <id>", "Also add imported contacts to a campaign")
    .option("--enrich", "Queue unenriched contacts for enrichment")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--json", "Structured output")
    .action(async (file, opts) => {
      if (!file && !opts.stdin) {
        out.error(
          "Provide a file path or use --stdin.\n  Example: tap import contacts.csv\n  Example: sink wash data.csv --json | tap import --stdin",
        );
        process.exit(1);
      }

      const spinner = ora("Reading input...").start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        // Read input
        let rawText: string;
        if (opts.stdin) {
          rawText = await readStdin();
        } else {
          rawText = readFileSync(file, "utf-8");
        }

        // Detect format
        let contacts: TapContactInsert[] = [];
        let sourceLabel = "";
        let totalRecords = 0;
        let skippedDuplicate = 0;
        let skippedInvalid = 0;
        let withEnrichment = 0;

        // Try parsing as JSON first
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          // Not JSON -- try JSONL
          const jsonlLines = rawText
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);

          if (jsonlLines.length > 0) {
            parsed = jsonlLines;
          }
        }

        if (parsed) {
          const sinkFormat = detectSinkFormat(parsed);

          if (sinkFormat !== "unknown") {
            // Sink format
            sourceLabel = `${opts.stdin ? "stdin" : file} (sink format detected)`;
            const records = extractSinkRecords(parsed, sinkFormat);
            totalRecords = records.length;

            const { valid, skippedDuplicate: dup, skippedInvalid: inv } =
              filterImportable(records);
            skippedDuplicate = dup;
            skippedInvalid = inv;

            for (const record of valid) {
              const mapped = mapSinkRecordToContact(record);
              if (mapped) {
                contacts.push(mapped);
                if (mapped.enriched) withEnrichment++;
              }
            }
          } else if (Array.isArray(parsed)) {
            // Plain JSON array
            sourceLabel = `${opts.stdin ? "stdin" : file} (JSON)`;
            totalRecords = parsed.length;

            for (const item of parsed as PlainContact[]) {
              const mapped = mapPlainContact(item);
              if (mapped) {
                contacts.push({
                  ...mapped,
                  platform_type: null,
                  genres: null,
                  coverage_area: null,
                  coverage_areas: null,
                  geographic_scope: null,
                  best_timing: null,
                  submission_guidelines: null,
                  pitch_tips: null,
                  enrichment_confidence: null,
                  contact_method: null,
                  enriched: false,
                  enriched_at: null,
                  enrichment_source: null,
                });
              } else {
                skippedInvalid++;
              }
            }
          }
        } else {
          // CSV
          sourceLabel = `${opts.stdin ? "stdin" : file} (CSV)`;
          const rows = parseCsv(rawText);
          totalRecords = rows.length;

          for (const row of rows) {
            const mapped = mapPlainContact(row);
            if (mapped) {
              contacts.push({
                ...mapped,
                platform_type: null,
                genres: null,
                coverage_area: null,
                coverage_areas: null,
                geographic_scope: null,
                best_timing: null,
                submission_guidelines: null,
                pitch_tips: null,
                enrichment_confidence: null,
                contact_method: null,
                enriched: false,
                enriched_at: null,
                enrichment_source: null,
              });
            } else {
              skippedInvalid++;
            }
          }
        }

        if (contacts.length === 0) {
          spinner.stop();
          out.error("No valid contacts found in input");
          process.exit(1);
        }

        // Deduplicate against workspace
        const emails = contacts.map((c) => c.email);
        const { data: existing } = await supabase
          .from("tap_contacts")
          .select("email")
          .eq("workspace_id", wsId)
          .in("email", emails);

        const existingEmails = new Set((existing || []).map((c) => c.email));
        const newContacts = contacts.filter((c) => !existingEmails.has(c.email));
        const alreadyInTap = contacts.length - newContacts.length;

        spinner.stop();

        // Preview
        console.log("");
        console.log(`  ${chalk.bold("Import Preview")}`);
        console.log(chalk.dim(`  ${GLYPH.divider.repeat(44)}`));
        console.log(`  ${"Source".padEnd(18)}${sourceLabel}`);
        console.log(`  ${"Total records".padEnd(18)}${totalRecords}`);
        console.log(`  ${"Valid emails".padEnd(18)}${contacts.length}`);
        if (skippedInvalid > 0) {
          console.log(`  ${"Invalid emails".padEnd(18)}${chalk.yellow(`${skippedInvalid} (skipped)`)}`);
        }
        if (skippedDuplicate > 0) {
          console.log(`  ${"Duplicates".padEnd(18)}${chalk.yellow(`${skippedDuplicate} (skipped)`)}`);
        }
        if (alreadyInTap > 0) {
          console.log(`  ${"Already in TAP".padEnd(18)}${chalk.yellow(`${alreadyInTap} (skipped)`)}`);
        }
        console.log(`  ${"New contacts".padEnd(18)}${chalk.green(newContacts.length)}`);
        if (withEnrichment > 0) {
          console.log(`  ${"With enrichment".padEnd(18)}${chalk.cyan(`${withEnrichment} contacts have sink enrichment`)}`);
        }
        console.log("");

        if (opts.json && opts.dryRun) {
          out.json({
            dryRun: true,
            source: sourceLabel,
            totalRecords,
            validEmails: contacts.length,
            skippedInvalid,
            skippedDuplicate,
            alreadyInTap,
            newContacts: newContacts.length,
            withEnrichment,
          });
          return;
        }

        if (newContacts.length === 0) {
          out.info("All contacts already exist in TAP");
          return;
        }

        if (opts.dryRun) {
          out.info("Dry run -- nothing imported");
          return;
        }

        // Confirmation
        if (!opts.yes) {
          const confirmed = await prompts.confirm({
            message: `Import ${newContacts.length} contacts?`,
          });
          if (prompts.isCancel(confirmed) || !confirmed) {
            console.log(chalk.dim("  Cancelled."));
            return;
          }
        }

        // Batch insert
        const importSpinner = ora(
          `Importing ${newContacts.length} contacts...`,
        ).start();

        const CHUNK_SIZE = 100;
        let imported = 0;
        let errors = 0;

        for (let i = 0; i < newContacts.length; i += CHUNK_SIZE) {
          const chunk = newContacts.slice(i, i + CHUNK_SIZE);
          const rows = chunk.map((c) => ({
            workspace_id: wsId,
            ...c,
            source: c.enrichment_source === "sink" ? "sink-import" : "cli-import",
            pipeline_status: "new" as const,
          }));

          const { error } = await supabase
            .from("tap_contacts")
            .upsert(rows, { onConflict: "workspace_id,email", ignoreDuplicates: true });

          if (error) {
            errors++;
          } else {
            imported += chunk.length;
          }

          // Progress bar
          const progress = Math.min(i + CHUNK_SIZE, newContacts.length);
          const ratio = progress / newContacts.length;
          const barWidth = 32;
          const filled = Math.round(ratio * barWidth);
          importSpinner.text = `Importing... ${GLYPH.blockFull.repeat(filled)}${GLYPH.blockLight.repeat(barWidth - filled)} ${progress}/${newContacts.length}`;
        }

        // Add to campaign if specified
        if (opts.campaign && imported > 0) {
          const importedEmails = newContacts.map((c) => c.email);
          const { data: importedContacts } = await supabase
            .from("tap_contacts")
            .select("id")
            .eq("workspace_id", wsId)
            .in("email", importedEmails);

          if (importedContacts && importedContacts.length > 0) {
            const campaignLinks = importedContacts.map((c) => ({
              project_id: opts.campaign,
              contact_id: c.id,
              pitch_status: "not_pitched",
            }));

            await supabase
              .from("campaign_contacts")
              .upsert(campaignLinks, {
                onConflict: "project_id,contact_id",
                ignoreDuplicates: true,
              });
          }
        }

        // Queue for enrichment
        if (opts.enrich && imported > 0) {
          const unenrichedEmails = newContacts
            .filter((c) => !c.enriched)
            .map((c) => c.email);

          if (unenrichedEmails.length > 0) {
            await supabase
              .from("tap_contacts")
              .update({ enrichment_source: "queued" })
              .eq("workspace_id", wsId)
              .in("email", unenrichedEmails)
              .is("enriched_at", null);
          }
        }

        importSpinner.stop();

        out.success(`${imported} contacts imported`);
        if (withEnrichment > 0) {
          const enrichedImported = newContacts.filter((c) => c.enriched).length;
          out.success(`${enrichedImported} imported with sink enrichment data`);
        }
        if (opts.enrich) {
          const unenrichedCount = newContacts.filter((c) => !c.enriched).length;
          if (unenrichedCount > 0) {
            out.success(`${unenrichedCount} queued for TAP enrichment`);
          }
        }
        if (opts.campaign) {
          out.success(`Added to campaign ${opts.campaign}`);
        }
        if (errors > 0) {
          out.warn(`${errors} batch${errors > 1 ? "es" : ""} had errors`);
        }

        if (opts.json) {
          out.json({
            imported,
            withEnrichment: newContacts.filter((c) => c.enriched).length,
            errors,
          });
        }

        console.log("");
        console.log(chalk.dim(`  tap contacts list --sort last-contacted`));
        console.log("");
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    });
}

/**
 * Read all data from stdin.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);

    // If stdin is a TTY (no pipe), reject quickly
    if (process.stdin.isTTY) {
      reject(new Error("No data piped to stdin. Use a file path or pipe data."));
    }
  });
}
