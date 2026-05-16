/**
 * Auth commands for the TAP CLI.
 *
 * Two flows:
 *   - `tap auth login --api-key`        (REST v1, preferred — default)
 *   - `tap auth login --legacy`         (deprecated direct-Supabase)
 *
 * Legacy direct-Supabase mode still works during the 30-day deprecation
 * window (removed 14 June 2026). A stderr warning prints whenever a
 * command falls back to it.
 */

import { Command } from "commander";
import * as clack from "@clack/prompts";
import { saveConfig, loadConfig, hasApiKey } from "../auth.js";
import * as out from "../output.js";

const REST_DEPRECATION_DATE = "14 June 2026";

export function authCommand(): Command {
  const cmd = new Command("auth").description("Manage authentication");

  cmd
    .command("login")
    .description(
      "Store TAP credentials. Default flow asks for a tap_ak_* key; pass --legacy for the deprecated direct-Supabase flow.",
    )
    .option("--api-key", "Force the REST v1 (tap_ak_*) flow (default)")
    .option(
      "--legacy",
      "Use the deprecated direct-Supabase flow (removed 14 June 2026)",
    )
    .action(async (opts: { apiKey?: boolean; legacy?: boolean }) => {
      const useLegacy = Boolean(opts.legacy) && !opts.apiKey;
      if (useLegacy) {
        await runLegacyLogin();
      } else {
        await runRestLogin();
      }
    });

  cmd
    .command("status")
    .description("Check authentication status")
    .action(() => {
      const config = loadConfig();
      if (!config) {
        out.warn(
          'Not authenticated. Run "tap auth login" or set TAP_API_KEY in your environment.',
        );
        return;
      }
      const rest = hasApiKey();
      out.success(rest ? "Authenticated (REST v1)" : "Authenticated (legacy)");
      if (rest) {
        out.info(`API key:  ${(config.apiKey ?? "").slice(0, 15)}...`);
        out.info(
          `Base URL: ${config.tapUrl ?? "https://totalaudiopromo.com"}`,
        );
      } else if (config.supabaseUrl && config.supabaseKey) {
        out.info(`Supabase URL: ${config.supabaseUrl}`);
        out.info(`Supabase key: ${config.supabaseKey.slice(0, 10)}...`);
        out.warn(
          `Legacy mode is deprecated. Migrate before ${REST_DEPRECATION_DATE} with \`tap auth login\`.`,
        );
      }
      if (config.workspaceId) out.info(`Workspace: ${config.workspaceId}`);
    });

  return cmd;
}

async function runRestLogin(): Promise<void> {
  clack.intro("TAP CLI — REST v1 authentication");
  clack.note(
    [
      "1. Sign in to https://totalaudiopromo.com",
      "2. Go to Settings → API Keys (Agency tier)",
      "3. Mint a key — choose the scopes you need:",
      "   campaigns:read campaigns:write pitches:read pitches:write",
      "   outcomes:read outcomes:write skills:read skills:write",
      "   approvals:read webhooks:read webhooks:write enrich validate",
      "4. Copy the key that starts with tap_ak_ and paste it below.",
    ].join("\n"),
    "Where to find your API key",
  );

  const apiKey = await clack.password({
    message: "Paste your tap_ak_ API key",
    validate: (v) => {
      if (!v) return "Required";
      if (!v.startsWith("tap_ak_")) return "Must start with tap_ak_";
      if (v.length < 40) return "Looks too short";
      return undefined;
    },
  });
  if (clack.isCancel(apiKey)) {
    clack.cancel("Cancelled");
    process.exit(0);
  }

  const workspaceId = await clack.text({
    message: "Workspace ID (optional — auto-resolved if blank)",
    placeholder: "Leave blank to auto-resolve",
  });
  if (clack.isCancel(workspaceId)) {
    clack.cancel("Cancelled");
    process.exit(0);
  }

  const tapUrl = await clack.text({
    message: "TAP base URL (press Enter for https://totalaudiopromo.com)",
    placeholder: "https://totalaudiopromo.com",
  });
  if (clack.isCancel(tapUrl)) {
    clack.cancel("Cancelled");
    process.exit(0);
  }

  const existing = loadConfig() ?? {};
  saveConfig({
    ...existing,
    apiKey: apiKey as string,
    tapUrl: (tapUrl as string) || undefined,
    workspaceId: (workspaceId as string) || existing.workspaceId,
  });

  clack.outro(
    "Credentials saved to ~/.tap/config.json. Try `tap skill list` to confirm.",
  );
}

async function runLegacyLogin(): Promise<void> {
  clack.intro("TAP CLI — legacy direct-Supabase authentication");
  clack.note(
    [
      `This path is deprecated and will be removed on ${REST_DEPRECATION_DATE}.`,
      "Prefer `tap auth login` (REST v1) instead.",
    ].join("\n"),
    "Deprecation",
  );

  const supabaseUrl = await clack.text({
    message: "Supabase URL",
    placeholder: "https://your-project.supabase.co",
    validate: (v) =>
      !v.startsWith("https://") ? "Must be a valid HTTPS URL" : undefined,
  });
  if (clack.isCancel(supabaseUrl)) {
    clack.cancel("Cancelled");
    process.exit(0);
  }

  const supabaseKey = await clack.password({
    message: "Supabase service role key",
    validate: (v) =>
      !v || v.length < 20 ? "Key looks too short" : undefined,
  });
  if (clack.isCancel(supabaseKey)) {
    clack.cancel("Cancelled");
    process.exit(0);
  }

  const workspaceId = await clack.text({
    message: "Workspace ID (optional, press Enter to skip)",
    placeholder: "Leave blank to auto-resolve",
  });
  if (clack.isCancel(workspaceId)) {
    clack.cancel("Cancelled");
    process.exit(0);
  }

  const existing = loadConfig() ?? {};
  saveConfig({
    ...existing,
    supabaseUrl: supabaseUrl as string,
    supabaseKey: supabaseKey as string,
    workspaceId: (workspaceId as string) || existing.workspaceId,
  });

  clack.outro(
    `Legacy credentials saved. Migrate to REST v1 before ${REST_DEPRECATION_DATE}.`,
  );
}
