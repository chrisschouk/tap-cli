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
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { readFileSync } from "node:fs";
import { getClient, resolveWorkspaceId, hasApiKey } from "../auth.js";
import { restRequest } from "../lib/rest.js";
import * as out from "../output.js";
import { COLOUR } from "../ui/theme.js";
import { createRailSpinner, stepComplete, blank, summaryBar } from "../ui/format.js";
import { sectionHeader, navHint } from "../ui/detail.js";
import { handleError } from "../ui/errors.js";
import {
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

const EMPTY_ENRICHMENT_FIELDS = {
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
} as const;

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

      const readRail = createRailSpinner("Reading input").start();

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

        readRail.succeed(`Reading input            ${opts.stdin ? "stdin" : file}`);

        // Parse
        const parseRail = createRailSpinner("Parsing").start();

        const contacts: TapContactInsert[] = [];
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
            sourceLabel = `sink format`;
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
            sourceLabel = `JSON`;
            totalRecords = parsed.length;

            for (const item of parsed as PlainContact[]) {
              const mapped = mapPlainContact(item);
              if (mapped) {
                contacts.push({ ...mapped, ...EMPTY_ENRICHMENT_FIELDS });
              } else {
                skippedInvalid++;
              }
            }
          }
        } else {
          sourceLabel = `CSV`;
          const rows = parseCsv(rawText);
          totalRecords = rows.length;

          for (const row of rows) {
            const mapped = mapPlainContact(row);
            if (mapped) {
              contacts.push({ ...mapped, ...EMPTY_ENRICHMENT_FIELDS });
            } else {
              skippedInvalid++;
            }
          }
        }

        if (contacts.length === 0) {
          parseRail.fail("No valid contacts found in input");
          process.exit(1);
        }

        parseRail.succeed(`Parsing                  ${totalRecords} records (${sourceLabel})`);

        if (hasApiKey()) {
          const payloadContacts = contacts.map(c => ({
            name: c.name,
            email: c.email,
            outlet: c.outlet,
            role: c.role,
            genres: c.genres,
            platform_type: c.platform_type,
            bbc_station: (c as any).bbc_station,
          }));

          if (opts.dryRun) {
            out.info(`Dry run -- would import ${payloadContacts.length} contacts`);
            return;
          }

          // Confirmation
          if (!opts.yes) {
            const confirmed = await prompts.confirm({
              message: `Import ${payloadContacts.length} contacts?`,
            });
            if (prompts.isCancel(confirmed) || !confirmed) {
              console.log(chalk.dim("  Cancelled."));
              return;
            }
          }

          const importRail = createRailSpinner(`Importing ${payloadContacts.length} contacts`).start();

          const res = await restRequest<{
            imported: number;
            results: Array<{ email: string; status: string; reason?: string }>;
          }>("/api/v1/contacts", {
            method: "POST",
            body: {
              contacts: payloadContacts,
            },
          });

          importRail.succeed(`Imported                ${res.imported} contacts`);

          const skipped = res.results.filter(r => r.status === 'skipped');
          if (skipped.length > 0) {
            out.warn(`${skipped.length} duplicate or invalid contacts skipped`);
          }

          if (opts.campaign && res.imported > 0) {
            const searchEmails = payloadContacts.map(c => c.email);
            const contactsRes = await restRequest<{ contacts: any[] }>("/api/v1/contacts", {
              query: { limit: 100 },
            });
            const importedIds = contactsRes.contacts
              .filter(c => searchEmails.includes(c.email))
              .map(c => c.id);

            if (importedIds.length > 0) {
              const linkRail = createRailSpinner(`Linking to campaign`).start();
              await restRequest(`/api/v1/campaigns/${encodeURIComponent(opts.campaign)}/contacts`, {
                method: "POST",
                body: {
                  contact_ids: importedIds,
                },
              });
              linkRail.succeed(`Linked contacts to campaign`);
            }
          }

          if (opts.enrich) {
            out.warn("Forcing enrichment queueing is not supported in REST mode.");
          }

          if (opts.json) {
            out.json(res);
            return;
          }

          blank();
          summaryBar([`${res.imported} imported`, `${skipped.length} skipped`]);
          navHint(["tap queue"]);
          blank();
          return;
        }

        // Deduplicate against workspace
        const dedupRail = createRailSpinner("Deduplicating").start();

        const emails = contacts.map((c) => c.email);
        const { data: existing } = await supabase
          .from("tap_contacts")
          .select("email")
          .eq("workspace_id", wsId)
          .in("email", emails);

        const existingEmails = new Set((existing || []).map((c) => c.email));
        const newContacts = contacts.filter((c) => !existingEmails.has(c.email));
        const alreadyInTap = contacts.length - newContacts.length;

        dedupRail.succeed(
          `Deduplicating            ${newContacts.length} new, ${alreadyInTap} existing`,
        );

        // Summary
        blank();
        sectionHeader("Import Preview");
        console.log(`  ${"Valid emails".padEnd(18)}${contacts.length}`);
        if (skippedInvalid > 0) {
          console.log(`  ${"Invalid".padEnd(18)}${chalk.hex(COLOUR.warning)(`${skippedInvalid} skipped`)}`);
        }
        if (skippedDuplicate > 0) {
          console.log(`  ${"Duplicates".padEnd(18)}${chalk.hex(COLOUR.warning)(`${skippedDuplicate} skipped`)}`);
        }
        if (alreadyInTap > 0) {
          console.log(`  ${"Already in TAP".padEnd(18)}${chalk.hex(COLOUR.warning)(`${alreadyInTap} skipped`)}`);
        }
        console.log(`  ${"New contacts".padEnd(18)}${chalk.hex(COLOUR.success)(String(newContacts.length))}`);
        if (withEnrichment > 0) {
          console.log(`  ${"With enrichment".padEnd(18)}${chalk.hex(COLOUR.primary)(`${withEnrichment} from sink`)}`);
        }
        blank();

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

        // Batch insert with progress
        const importRail = createRailSpinner(
          `Importing ${newContacts.length} contacts`,
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
        }

        importRail.succeed(`Importing                ${imported} contacts`);

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

          stepComplete(`Campaign                 ${opts.campaign.slice(0, 8)}`);
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

            stepComplete(`Enrichment queued        ${unenrichedEmails.length} contacts`);
          }
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

        // Summary
        const summaryParts: string[] = [];
        summaryParts.push(`${imported} imported`);
        if (errors > 0) summaryParts.push(chalk.hex(COLOUR.danger)(`${errors} errors`));
        if (newContacts.filter((c) => c.enriched).length > 0) {
          summaryParts.push(`${newContacts.filter((c) => c.enriched).length} enriched`);
        }
        blank();
        summaryBar(summaryParts);

        navHint([
          "tap contacts list --sort last-contacted",
          "tap queue",
        ]);
        blank();
      } catch (err) {
        handleError(err);
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
