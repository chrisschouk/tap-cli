/**
 * `tap skill` — workspace skill management via REST v1.
 *
 * Mirrors the surface exposed by the MCP server's tap_list_skills /
 * tap_get_skill / tap_run_skill / tap_fork_skill / tap_get_invocation
 * tools. Power-user terminal entry point for the same skill set Claude
 * Code agents can drive.
 *
 * Every subcommand goes through `lib/rest.ts → restRequest()` with a
 * `tap_ak_*` key. No Supabase client is touched here.
 */

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as clack from "@clack/prompts";
import { restRequest, TapApiError } from "../lib/rest.js";
import * as out from "../output.js";

interface SkillListItem {
  slug: string;
  name: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  source: "default" | "workspace";
  body_length: number;
}

interface SkillDetail {
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  type: "programmatic" | "llm" | "hybrid";
  tools: string[];
  permissions: Record<string, boolean>;
  io: { input_schema: unknown; output_schema: unknown };
  body: string;
  source: "default" | "workspace";
}

interface InvocationResult {
  skill_slug: string;
  invocation_id: string | null;
  ok: boolean;
  output: Record<string, unknown> | null;
  error: string | null;
  duration_ms: number;
  tokens_used: number | null;
  confidence: number | null;
}

function describeError(err: unknown): string {
  if (err instanceof TapApiError) return `API ${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function skillCommand(): Command {
  const cmd = new Command("skill").description(
    "Manage workspace skills (list, view, run, fork, invocations)",
  );

  cmd
    .command("list")
    .description("List every skill visible to this workspace")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const data = await restRequest<{ skills: SkillListItem[]; total: number }>(
          "/api/v1/skills",
        );
        if (opts.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + "\n");
          return;
        }
        if (data.skills.length === 0) {
          out.info("No skills available in this workspace.");
          return;
        }
        out.success(`${data.total} skill${data.total === 1 ? "" : "s"}`);
        for (const s of data.skills) {
          const sourceTag = s.source === "workspace" ? "[forked]" : "       ";
          process.stdout.write(
            `  ${sourceTag} ${s.slug.padEnd(28)} ${s.version.padEnd(8)} ${s.name}\n`,
          );
        }
      } catch (err) {
        out.error(`Failed to list skills: ${describeError(err)}`);
        process.exit(1);
      }
    });

  cmd
    .command("view <slug>")
    .description("Show a single skill's manifest and body")
    .option("--json", "Output JSON")
    .option("--body-only", "Print only the markdown body")
    .action(async (slug: string, opts: { json?: boolean; bodyOnly?: boolean }) => {
      try {
        const data = await restRequest<{ skill: SkillDetail }>(
          `/api/v1/skills/${encodeURIComponent(slug)}`,
        );
        if (opts.json) {
          process.stdout.write(JSON.stringify(data.skill, null, 2) + "\n");
          return;
        }
        if (opts.bodyOnly) {
          process.stdout.write(data.skill.body);
          if (!data.skill.body.endsWith("\n")) process.stdout.write("\n");
          return;
        }
        const s = data.skill;
        out.success(`${s.name} (${s.slug})`);
        out.info(`Version:     ${s.version}`);
        out.info(`Type:        ${s.type}`);
        out.info(`Category:    ${s.category}`);
        out.info(`Source:      ${s.source}`);
        out.info(`Tags:        ${s.tags.join(", ") || "(none)"}`);
        out.info(`Tools:       ${s.tools.join(", ") || "(none)"}`);
        out.info(`Permissions: ${JSON.stringify(s.permissions)}`);
        process.stdout.write("\n--- body ---\n");
        process.stdout.write(s.body);
        if (!s.body.endsWith("\n")) process.stdout.write("\n");
      } catch (err) {
        out.error(`Failed to fetch skill: ${describeError(err)}`);
        process.exit(1);
      }
    });

  cmd
    .command("run <slug>")
    .description("Execute a workspace skill")
    .option(
      "--input <json>",
      'Skill input as a JSON string. Defaults to {} if omitted.',
      "{}",
    )
    .option("--input-file <path>", "Read input JSON from a file")
    .option("--json", "Output JSON")
    .action(
      async (
        slug: string,
        opts: { input: string; inputFile?: string; json?: boolean },
      ) => {
        let inputRaw = opts.input;
        if (opts.inputFile) {
          try {
            inputRaw = readFileSync(opts.inputFile, "utf-8");
          } catch (err) {
            out.error(`Failed to read --input-file: ${describeError(err)}`);
            process.exit(1);
          }
        }

        let input: Record<string, unknown>;
        try {
          input = JSON.parse(inputRaw) as Record<string, unknown>;
        } catch (err) {
          out.error(`Invalid JSON for --input: ${describeError(err)}`);
          process.exit(1);
        }

        try {
          const data = await restRequest<InvocationResult>(
            `/api/v1/skills/${encodeURIComponent(slug)}/run`,
            { method: "POST", body: { input } },
          );

          if (opts.json) {
            process.stdout.write(JSON.stringify(data, null, 2) + "\n");
            return;
          }

          if (data.ok) {
            out.success(`Ran ${data.skill_slug} in ${data.duration_ms}ms`);
            if (data.invocation_id) out.info(`Invocation: ${data.invocation_id}`);
            if (data.tokens_used !== null) out.info(`Tokens: ${data.tokens_used}`);
            if (data.confidence !== null)
              out.info(`Confidence: ${data.confidence}`);
            if (data.output) {
              process.stdout.write("\n--- output ---\n");
              process.stdout.write(JSON.stringify(data.output, null, 2) + "\n");
            }
          } else {
            out.error(`Skill ${slug} failed in ${data.duration_ms}ms`);
            if (data.invocation_id) out.info(`Invocation: ${data.invocation_id}`);
            if (data.error) out.info(`Error: ${data.error}`);
            process.exit(1);
          }
        } catch (err) {
          out.error(`Failed to run skill: ${describeError(err)}`);
          process.exit(1);
        }
      },
    );

  cmd
    .command("edit <slug>")
    .description("Open the skill body in $EDITOR and save as a workspace fork")
    .action(async (slug: string) => {
      let detail: SkillDetail;
      try {
        const data = await restRequest<{ skill: SkillDetail }>(
          `/api/v1/skills/${encodeURIComponent(slug)}`,
        );
        detail = data.skill;
      } catch (err) {
        out.error(`Failed to fetch skill: ${describeError(err)}`);
        process.exit(1);
        return;
      }

      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const tmpPath = join(
        tmpdir(),
        `tap-skill-${slug}-${randomBytes(4).toString("hex")}.md`,
      );
      writeFileSync(tmpPath, detail.body, { mode: 0o600 });

      const result = spawnSync(editor, [tmpPath], { stdio: "inherit" });
      if (result.error || (result.status !== 0 && result.status !== null)) {
        unlinkSync(tmpPath);
        out.error(`Editor exited with status ${result.status}`);
        process.exit(result.status ?? 1);
      }

      let edited: string;
      try {
        edited = readFileSync(tmpPath, "utf-8");
      } finally {
        try {
          unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }

      if (edited === detail.body) {
        out.info("No changes — nothing to fork.");
        return;
      }

      const proceed = await clack.confirm({
        message: `Fork ${slug} with ${edited.length}-char body? Current source: ${detail.source}.`,
      });
      if (clack.isCancel(proceed) || !proceed) {
        out.info("Cancelled.");
        return;
      }

      try {
        await restRequest<{ slug: string; source: string; body_length: number }>(
          `/api/v1/skills/${encodeURIComponent(slug)}/fork`,
          { method: "POST", body: { body: edited } },
        );
        out.success(`Forked ${slug}. Next run uses the workspace override.`);
      } catch (err) {
        out.error(`Failed to fork skill: ${describeError(err)}`);
        process.exit(1);
      }
    });

  cmd
    .command("reset <slug>")
    .description("Drop the workspace fork and restore the TAP default body")
    .action(async (slug: string) => {
      const proceed = await clack.confirm({
        message: `Reset ${slug} to the TAP default body? Your workspace fork will be removed.`,
      });
      if (clack.isCancel(proceed) || !proceed) {
        out.info("Cancelled.");
        return;
      }

      try {
        await restRequest<{ slug: string; source: string }>(
          `/api/v1/skills/${encodeURIComponent(slug)}/fork`,
          { method: "POST", body: { body: null } },
        );
        out.success(`Reset ${slug} to default.`);
      } catch (err) {
        out.error(`Failed to reset skill: ${describeError(err)}`);
        process.exit(1);
      }
    });

  cmd
    .command("invocation <id>")
    .description("Fetch a single skill_invocation audit row by id")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const data = await restRequest<{ invocation: Record<string, unknown> }>(
          `/api/v1/invocations/${encodeURIComponent(id)}`,
        );
        if (opts.json) {
          process.stdout.write(JSON.stringify(data.invocation, null, 2) + "\n");
          return;
        }
        const inv = data.invocation;
        out.success(`Invocation ${inv.id}`);
        out.info(`Skill:      ${inv.skill_slug} (${inv.version})`);
        out.info(`Status:     ${inv.status}`);
        out.info(`Duration:   ${inv.duration_ms}ms`);
        if (inv.tokens_used !== null) out.info(`Tokens:     ${inv.tokens_used}`);
        if (inv.confidence !== null) out.info(`Confidence: ${inv.confidence}`);
        out.info(`Created:    ${inv.created_at}`);
        if (inv.error) {
          process.stdout.write("\n--- error ---\n");
          process.stdout.write(String(inv.error) + "\n");
        }
        if (inv.inputs) {
          process.stdout.write("\n--- inputs ---\n");
          process.stdout.write(JSON.stringify(inv.inputs, null, 2) + "\n");
        }
        if (inv.outputs) {
          process.stdout.write("\n--- outputs ---\n");
          process.stdout.write(JSON.stringify(inv.outputs, null, 2) + "\n");
        }
      } catch (err) {
        out.error(`Failed to fetch invocation: ${describeError(err)}`);
        process.exit(1);
      }
    });

  return cmd;
}
