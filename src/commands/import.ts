/**
 * Import command: contacts from sink (datasink), CSV or JSON into TAP.
 *
 * Usage:
 *   tap import contacts.csv
 *   sink wash contacts.csv --json -q | tap import - --yes
 *   tap import washed.json --campaign <campaign-id>
 *   tap import contacts.csv --wash          (runs `sink wash` first, if installed)
 */

import { Command } from "commander";
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fetchAllPages, restRequest } from "../lib/rest.js";
import { parseImport, type ContactPayload, type ParsedImport } from "../lib/contact-import.js";
import * as out from "../output.js";
import { createRailSpinner, blank, stepComplete, summaryBar } from "../ui/format.js";
import { navHint } from "../ui/detail.js";
import { handleError } from "../ui/errors.js";

/** POST /api/v1/contacts refuses more than 500 contacts per request. */
const IMPORT_BATCH = 500;
/** POST /api/v1/campaigns/:id/contacts refuses more than 200 ids per request. */
const LINK_BATCH = 200;

interface ImportOptions {
  stdin?: boolean;
  wash?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  campaign?: string;
  enrich?: boolean;
  json?: boolean;
}

interface ImportTotals {
  imported: number;
  skipped: number;
  invalid: number;
  duplicatesInRequest: number;
}

interface LinkTotals {
  added: number;
  already_linked: number;
  not_found: number;
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return Promise.reject(new Error("Nothing piped to stdin. Pass a file, or pipe sink's output: sink wash contacts.csv --json -q | tap import - --yes"));
  }
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    process.stdin.on("data", (chunk) => parts.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(parts).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

/** Run `sink wash` on the input and hand back its JSON. sink reads stdin when given "-". */
function washWithSink(file: string): string {
  const res = spawnSync("sink", ["wash", file, "--json", "-q"], {
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["inherit", "pipe", "inherit"],
  });
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new Error(
      "--wash needs sink on your PATH (npm i -g datasink). Or pipe it: npx -y datasink wash contacts.csv --json -q | tap import - --yes",
    );
  }
  if (res.status !== 0) throw new Error(`sink wash exited with code ${res.status}`);
  return res.stdout;
}

function readInput(file: string, opts: ImportOptions): Promise<string> {
  if (opts.wash) return Promise.resolve(washWithSink(file));
  if (file === "-") return readStdin();
  return Promise.resolve(readFileSync(file, "utf-8"));
}

async function importBatches(contacts: ContactPayload[]): Promise<ImportTotals> {
  const totals: ImportTotals = { imported: 0, skipped: 0, invalid: 0, duplicatesInRequest: 0 };
  for (const batch of chunks(contacts, IMPORT_BATCH)) {
    const res = await restRequest<ImportTotals>("/api/v1/contacts", { method: "POST", body: { contacts: batch } });
    totals.imported += res.imported ?? 0;
    totals.skipped += res.skipped ?? 0;
    totals.invalid += res.invalid ?? 0;
    totals.duplicatesInRequest += res.duplicatesInRequest ?? 0;
  }
  return totals;
}

/**
 * Link every contact in the file to the campaign, new or already in TAP.
 * The import response lists at most 100 results and no ids, so ids come from
 * the workspace's contact list, matched by email.
 */
async function linkToCampaign(campaignId: string, contacts: ContactPayload[]): Promise<LinkTotals> {
  const rows = await fetchAllPages<{ id: string; email: string }>("/api/v1/contacts", "contacts");
  const idByEmail = new Map(rows.map((r) => [r.email.toLowerCase(), r.id]));
  const ids = contacts.map((c) => idByEmail.get(c.email)).filter((id): id is string => Boolean(id));
  const totals: LinkTotals = { added: 0, already_linked: 0, not_found: contacts.length - ids.length };
  for (const batch of chunks(ids, LINK_BATCH)) {
    const res = await restRequest<{ added: number; already_linked: number }>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/contacts`,
      { method: "POST", body: { contact_ids: batch } },
    );
    totals.added += res.added ?? 0;
    totals.already_linked += res.already_linked ?? 0;
  }
  return totals;
}

function reportParse(parsed: ParsedImport, source: string): void {
  stepComplete("Read", `${parsed.total} rows from ${source} (${parsed.format})`);
  const skipped = [
    parsed.skippedDuplicate > 0 ? `${parsed.skippedDuplicate} duplicate` : "",
    parsed.skippedInvalid > 0 ? `${parsed.skippedInvalid} without a valid email` : "",
  ].filter(Boolean);
  if (skipped.length > 0) stepComplete("Skipped", skipped.join(", "));
  if (parsed.dropped.length > 0) {
    out.warn(`TAP does not store ${parsed.dropped.join(", ")}. Those values stay in your file.`);
  }
}

async function confirmImport(count: number, opts: ImportOptions, fromStdin: boolean): Promise<boolean> {
  if (opts.yes) return true;
  if (fromStdin) {
    out.error("Add --yes when piping into tap import, since the prompt cannot read a piped stdin.");
    process.exit(1);
  }
  const confirmed = await prompts.confirm({ message: `Import ${count} contacts into TAP?` });
  return !prompts.isCancel(confirmed) && confirmed === true;
}

function reportDone(parsed: ParsedImport, totals: ImportTotals, linked: LinkTotals | null, opts: ImportOptions): void {
  if (opts.json) {
    const { contacts, ...input } = parsed;
    out.json({ input: { ...input, contacts: contacts.length }, ...totals, campaign: linked });
    return;
  }
  if (linked) {
    const missing = linked.not_found > 0 ? `, ${linked.not_found} not found in TAP` : "";
    stepComplete("Linked", `${linked.added} added to the campaign, ${linked.already_linked} already on it${missing}`);
  }
  blank();
  summaryBar([
    `${totals.imported} imported`,
    `${totals.skipped} already in TAP`,
    `${totals.invalid + totals.duplicatesInRequest} rejected`,
  ]);
  navHint(opts.campaign ? [`tap campaigns show ${opts.campaign}`] : ["tap contacts list"]);
  blank();
}

function sourceLabel(source: string, opts: ImportOptions): string {
  if (opts.wash) return `sink wash ${source}`;
  return source === "-" ? "stdin" : source;
}

/** Send the contacts, then link them to the campaign when asked. Rails stay off stdout under --json. */
async function sendToTap(contacts: ContactPayload[], opts: ImportOptions) {
  const rail = opts.json ? null : createRailSpinner(`Importing ${contacts.length} contacts`).start();
  const totals = await importBatches(contacts);
  rail?.succeed("Imported", `${totals.imported} new, ${totals.skipped} already in TAP`);
  if (!opts.campaign) return { totals, linked: null };

  const linkRail = opts.json ? null : createRailSpinner("Linking to the campaign").start();
  const linked = await linkToCampaign(opts.campaign, contacts);
  linkRail?.stop();
  return { totals, linked };
}

async function runImport(file: string | undefined, opts: ImportOptions): Promise<void> {
  const source = opts.stdin || !file ? "-" : file;
  const parsed = parseImport(await readInput(source, opts));
  if (!opts.json) reportParse(parsed, sourceLabel(source, opts));

  if (parsed.contacts.length === 0) {
    out.error("No contacts with a valid email in the input");
    process.exit(1);
  }
  if (opts.dryRun) {
    out.info(`Dry run: would send ${parsed.contacts.length} contacts to TAP in ${chunks(parsed.contacts, IMPORT_BATCH).length} request(s)`);
    return;
  }
  if (!(await confirmImport(parsed.contacts.length, opts, source === "-" && !opts.wash))) {
    console.log(chalk.dim("  Cancelled."));
    return;
  }

  const { totals, linked } = await sendToTap(parsed.contacts, opts);
  if (opts.enrich) out.warn("--enrich is not wired up yet. Run `tap contacts enrich <id>` per contact.");
  reportDone(parsed, totals, linked, opts);
}

export function importCommand(): Command {
  return new Command("import")
    .description("Import contacts from sink, CSV or JSON (use - to read stdin)")
    .argument("[file]", "CSV, JSON or JSONL file, or - for stdin")
    .option("--stdin", "Read from stdin (same as passing -)")
    .option("--wash", "Run `sink wash` on the file first (needs sink on your PATH)")
    .option("--yes", "Skip confirmation (required when piping)")
    .option("--dry-run", "Show what would be imported without calling TAP")
    .option("--campaign <id>", "Also add every contact in the file to this campaign")
    .option("--enrich", "Queue unenriched contacts for enrichment (not wired up yet)")
    .option("--json", "Structured output")
    .addHelpText("after", `
Examples:
  tap import contacts.csv
  sink wash contacts.csv --json -q | tap import - --yes
  sink drain washed.json --format csv -o clean.csv && tap import clean.csv
  tap import contacts.csv --wash --campaign <campaign-id>`)
    .action(async (file: string | undefined, opts: ImportOptions) => {
      try {
        await runImport(file, opts);
      } catch (err) {
        handleError(err);
        process.exit(1);
      }
    });
}
