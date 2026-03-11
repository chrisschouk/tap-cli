/**
 * Auth commands for the TAP CLI.
 */

import { Command } from "commander";
import * as clack from "@clack/prompts";
import { saveConfig, loadConfig } from "../auth.js";
import * as out from "../output.js";

export function authCommand(): Command {
  const cmd = new Command("auth").description("Manage authentication");

  cmd
    .command("login")
    .description("Store Supabase credentials for TAP access")
    .action(async () => {
      clack.intro("TAP CLI — Authentication");

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

      saveConfig({
        supabaseUrl: supabaseUrl as string,
        supabaseKey: supabaseKey as string,
        workspaceId: (workspaceId as string) || undefined,
      });

      clack.outro("Credentials saved to ~/.tap/config.json");
    });

  cmd
    .command("status")
    .description("Check authentication status")
    .action(() => {
      const config = loadConfig();
      if (config) {
        out.success("Authenticated");
        out.info(`URL: ${config.supabaseUrl}`);
        out.info(`Key: ${config.supabaseKey.slice(0, 10)}...`);
        if (config.workspaceId) out.info(`Workspace: ${config.workspaceId}`);
      } else {
        out.warn(
          'Not authenticated. Run "tap auth login" or set environment variables.',
        );
      }
    });

  return cmd;
}
