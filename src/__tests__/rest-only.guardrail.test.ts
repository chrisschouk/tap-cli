import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const files = sourceFiles(join(process.cwd(), "src")).map((path) => ({ path, text: readFileSync(path, "utf-8") }));

describe("the CLI reaches TAP only through REST v1", () => {
  it("never imports a Supabase client", () => {
    const offenders = files.filter((f) => f.text.includes("@supabase/")).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("never calls an approve or send route; approving and sending are human-only in TAP", () => {
    const offenders = files
      .filter((f) => /["'`]\/api\/[^"'`]*(approv|\/send)/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
