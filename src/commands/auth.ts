/**
 * Auth commands for the TAP CLI. `tap auth login` stores a REST v1
 * `tap_ak_*` key after verifying it against TAP.
 */

import { Command } from "commander";
import * as clack from "@clack/prompts";
import { saveConfig, loadConfig } from "../auth.js";
import { verifyApiKey } from "../lib/rest.js";
import { checkApiKeyFormat } from "../lib/key-validation.js";
import { openUrl } from "../lib/browser.js";
import * as out from "../output.js";

const API_KEYS_URL = "https://totalaudiopromo.com/settings/api-keys";

export function authCommand(): Command {
  const cmd = new Command("auth").description("Manage authentication");

  cmd
    .command("login")
    .description("Store a TAP API key (tap_ak_*)")
    .option("--api-key", "Accepted for compatibility; the API key flow is the only flow")
    .action(runRestLogin);

  cmd
    .command("status")
    .description("Check authentication status")
    .action(() => {
      const config = loadConfig();
      if (!config?.apiKey) {
        out.warn(
          'Not authenticated. Run "tap auth login" or set TAP_API_KEY in your environment.',
        );
        return;
      }
      out.success("Authenticated (REST v1)");
      out.info(`API key:  ${config.apiKey.slice(0, 15)}...`);
      out.info(`Base URL: ${config.tapUrl ?? "https://totalaudiopromo.com"}`);
    });

  return cmd;
}

async function runRestLogin(): Promise<void> {
  clack.intro("TAP CLI — REST v1 authentication");
  clack.note(
    [
      "1. Sign in to https://totalaudiopromo.com",
      "2. Go to Settings → API Keys",
      "3. Mint a key — choose the scopes you need:",
      "   campaigns:read campaigns:write pitches:read pitches:write",
      "   outcomes:read outcomes:write skills:read skills:write",
      "   approvals:read webhooks:read webhooks:write enrich validate",
      "4. Copy the key that starts with tap_ak_ and paste it below.",
    ].join("\n"),
    "Where to find your API key",
  );

  const shouldOpen = await clack.confirm({
    message: `Open ${API_KEYS_URL} in your browser now?`,
    initialValue: true,
  });
  if (clack.isCancel(shouldOpen)) {
    clack.cancel("Cancelled");
    process.exit(0);
  }
  if (shouldOpen) {
    openUrl(API_KEYS_URL, (message) => {
      clack.log.warn(`Could not open browser automatically: ${message}`);
      clack.log.info(`Visit ${API_KEYS_URL} manually.`);
    });
  }

  const apiKey = await clack.password({
    message: "Paste your tap_ak_ API key",
    validate: (v) => checkApiKeyFormat(v).reason,
  });
  if (clack.isCancel(apiKey)) {
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

  const resolvedUrl = (tapUrl as string) || undefined;
  const spin = clack.spinner();
  spin.start("Verifying key against TAP");
  const result = await verifyApiKey(apiKey as string, resolvedUrl);
  if (!result.ok) {
    spin.stop("Verification failed");
    reportVerifyFailure(result);
    process.exit(1);
  }
  spin.stop(
    result.scoped
      ? "Key verified"
      : "Key verified (no campaigns:read scope — some commands will need a broader key)",
  );

  const existing = loadConfig() ?? {};
  saveConfig({
    ...existing,
    apiKey: apiKey as string,
    tapUrl: resolvedUrl,
  });

  clack.outro(
    "Credentials saved to ~/.tap/config.json. Try `tap skill list` to confirm, then `tap mcp setup` to wire up an MCP client.",
  );
}

function reportVerifyFailure(
  result: Extract<Awaited<ReturnType<typeof verifyApiKey>>, { ok: false }>,
): void {
  if (result.reason === "invalid-key") {
    clack.log.error("TAP rejected that key (401) — check you copied it in full.");
  } else if (result.reason === "network") {
    clack.log.error(`Could not reach TAP: ${result.message}`);
    clack.log.info("Check your connection and try again.");
  } else {
    clack.log.error(result.message);
  }
}
