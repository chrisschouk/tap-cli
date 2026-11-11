/**
 * Turns an import file into the contact rows `POST /api/v1/contacts` accepts.
 *
 * Inputs: sink (`datasink`) output as JSON (`wash --json` envelope or
 * `--format json` array), JSONL or CSV, and plain CSV or JSON contact lists.
 * Every input is flattened to a row of named values, then one alias table
 * maps the row to TAP's fields. Values TAP does not store are reported by
 * name so the user knows they stay in the file.
 */

/** The fields POST /api/v1/contacts reads (apps/tap/app/api/v1/contacts/route.ts). */
export interface ContactPayload {
  email: string;
  name?: string;
  outlet?: string;
  role?: string;
  platform_type?: string;
  genres?: string[];
  geographic_scope?: string;
  notes?: string;
}

export type ImportFormat = "sink JSON" | "sink JSONL" | "JSON" | "CSV";

export interface ParsedImport {
  format: ImportFormat;
  total: number;
  contacts: ContactPayload[];
  skippedDuplicate: number;
  skippedInvalid: number;
  /** Column or field names with values TAP drops, in first-seen order. */
  dropped: string[];
}

type Row = Record<string, unknown>;
type Field = keyof ContactPayload;

/** Header and key spellings for each TAP field, matched case-insensitively. */
const ALIASES: Record<Field, string[]> = {
  email: ["email", "email address", "e-mail"],
  name: ["name", "full name", "contact name"],
  outlet: ["outlet", "station", "publication"],
  role: ["role", "title"],
  platform_type: ["platform_type", "platform type", "platformtype"],
  genres: ["genres", "genre"],
  geographic_scope: ["geographic_scope", "geographic scope", "geographicscope"],
  notes: ["notes"],
};

/** sink's bookkeeping columns: read to skip rows, never reported as dropped. */
const SINK_FLAGS = ["email_valid", "duplicate", "email_confidence"];

const KNOWN_KEYS = new Set([...Object.values(ALIASES).flat(), ...SINK_FLAGS]);

function isPresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function lowerKeys(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
}

function pick(row: Row, field: Field): unknown {
  const key = ALIASES[field].find((alias) => isPresent(row[alias]));
  return key === undefined ? undefined : row[key];
}

function text(value: unknown): string | undefined {
  return isPresent(value) ? String(value).trim() : undefined;
}

function genreList(value: unknown): string[] | undefined {
  if (!isPresent(value)) return undefined;
  const items = Array.isArray(value) ? value.map(String) : String(value).split(/[;,]/);
  const genres = items.map((g) => g.trim()).filter(Boolean);
  return genres.length > 0 ? genres : undefined;
}

function isFlag(value: unknown, flag: boolean): boolean {
  return value === flag || String(value).toLowerCase() === String(flag);
}

type MappedRow =
  | { kind: "contact"; contact: ContactPayload; dropped: string[] }
  | { kind: "duplicate" }
  | { kind: "invalid" };

export function mapRow(input: Row): MappedRow {
  const row = lowerKeys(input);
  if (isFlag(row.duplicate, true)) return { kind: "duplicate" };
  const email = text(pick(row, "email"))?.toLowerCase();
  if (!email || !email.includes("@") || isFlag(row.email_valid, false)) return { kind: "invalid" };

  const contact: ContactPayload = { email };
  for (const field of ["name", "outlet", "role", "platform_type", "geographic_scope", "notes"] as const) {
    const value = text(pick(row, field));
    if (value) contact[field] = value;
  }
  const genres = genreList(pick(row, "genres"));
  if (genres) contact.genres = genres;

  const dropped = Object.keys(row).filter((k) => !KNOWN_KEYS.has(k) && isPresent(row[k]));
  return { kind: "contact", contact, dropped };
}

// -- sink records --------------------------------------------------------------

interface SinkRecord {
  raw: Row & { extras?: Row };
  scrub?: { email?: { normalised?: string; valid?: boolean } };
  rinse?: { duplicate?: boolean };
  soak?: Row;
  steep?: Row;
}

/** soak keys TAP stores, renamed to its fields. Every other soak key is dropped. */
const SOAK_FIELDS: Record<string, string> = {
  platformType: "platform_type",
  genres: "genres",
  geographicScope: "geographic_scope",
};

/** soak keys that describe the run, not the contact. */
const SOAK_META = new Set(["provider", "reasoning", "platform"]);

function soakRow(soak: Row | undefined): Row {
  const row: Row = {};
  for (const [key, value] of Object.entries(soak ?? {})) {
    if (SOAK_META.has(key)) continue;
    row[SOAK_FIELDS[key] ?? `soak ${key}`] = value;
  }
  return row;
}

export function flattenSinkRecord(record: SinkRecord): Row {
  const { extras, ...raw } = record.raw;
  return {
    ...raw,
    ...extras,
    ...soakRow(record.soak),
    email: record.scrub?.email?.normalised || raw.email,
    email_valid: record.scrub?.email?.valid,
    duplicate: record.rinse?.duplicate,
    "steep (socials, portals)": record.steep ? "yes" : undefined,
  };
}

function isSinkRecord(value: unknown): value is SinkRecord {
  return typeof value === "object" && value !== null && "raw" in value;
}

// -- CSV -----------------------------------------------------------------------

/** Read a quoted cell starting after its opening quote. Returns the cell and the index after the closing quote. */
function readQuoted(source: string, start: number): [string, number] {
  let cell = "";
  let i = start;
  while (i < source.length) {
    if (source[i] === '"' && source[i + 1] === '"') {
      cell += '"';
      i += 2;
    } else if (source[i] === '"') {
      return [cell, i + 1];
    } else {
      cell += source[i++];
    }
  }
  return [cell, i];
}

/** RFC 4180 rows: quoted cells may hold commas, newlines and doubled quotes. */
export function csvRows(source: string): string[][] {
  const rows: string[][] = [];
  const row: string[] = [];
  let cell = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      [cell, i] = readQuoted(source, i + 1);
      continue;
    }
    if (ch === "," || ch === "\n") {
      row.push(cell);
      cell = "";
      if (ch === "\n") rows.push(row.splice(0));
    } else if (ch !== "\r") {
      cell += ch;
    }
    i++;
  }
  if (cell || row.length > 0) rows.push([...row, cell]);
  return rows;
}

function csvObjects(source: string): Row[] {
  const [header, ...rows] = csvRows(source.replace(/^\uFEFF/, ""));
  if (!header) return [];
  return rows
    .filter((cells) => cells.some((c) => c.trim()))
    .map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

// -- format detection ------------------------------------------------------------

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function parseJsonl(source: string): unknown[] | undefined {
  const lines = source.split("\n").filter((l) => l.trim());
  const values = lines.map(parseJson);
  return lines.length > 0 && values.every((v) => typeof v === "object" && v !== null) ? values : undefined;
}

function recordsOf(json: unknown): unknown[] | undefined {
  if (Array.isArray(json)) return json;
  const records = (json as { records?: unknown } | null)?.records;
  return Array.isArray(records) ? records : undefined;
}

function detect(source: string): { format: ImportFormat; rows: Row[] } {
  const jsonRecords = recordsOf(parseJson(source));
  if (jsonRecords) return fromRecords(jsonRecords, "sink JSON", "JSON");
  const jsonl = parseJsonl(source);
  if (jsonl) return fromRecords(jsonl, "sink JSONL", "JSON");
  return { format: "CSV", rows: csvObjects(source) };
}

function fromRecords(records: unknown[], sinkFormat: ImportFormat, plainFormat: ImportFormat) {
  if (records.length > 0 && records.every(isSinkRecord)) {
    return { format: sinkFormat, rows: records.map(flattenSinkRecord) };
  }
  return { format: plainFormat, rows: records.filter((r): r is Row => typeof r === "object" && r !== null) };
}

export function parseImport(source: string): ParsedImport {
  const { format, rows } = detect(source);
  const parsed: ParsedImport = { format, total: rows.length, contacts: [], skippedDuplicate: 0, skippedInvalid: 0, dropped: [] };
  const seen = new Set<string>();
  const dropped = new Set<string>();

  for (const row of rows) {
    const mapped = mapRow(row);
    if (mapped.kind === "invalid") {
      parsed.skippedInvalid++;
      continue;
    }
    if (mapped.kind === "duplicate" || seen.has(mapped.contact.email)) {
      parsed.skippedDuplicate++;
      continue;
    }
    seen.add(mapped.contact.email);
    parsed.contacts.push(mapped.contact);
    mapped.dropped.forEach((name) => dropped.add(name));
  }
  parsed.dropped = [...dropped];
  return parsed;
}
