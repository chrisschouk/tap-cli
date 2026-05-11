/**
 * Open command -- open TAP in the browser from the terminal.
 *
 * Usage:
 *   tap open                    # open TAP home
 *   tap open <id>               # detect type and open correct page
 *   tap open <id> --url         # print URL only
 */

import { Command } from "commander";
import { exec } from "node:child_process";
import { platform } from "node:os";
import { getClient } from "../auth.js";
import * as out from "../output.js";
import { handleError } from "../ui/errors.js";

const TAP_BASE = "https://tap.totalaudiopromo.com";

function openUrl(url: string): void {
  const cmd = platform() === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      out.error(`Failed to open browser: ${err.message}`);
      out.info(`URL: ${url}`);
    }
  });
}

export function openCommand(): Command {
  return new Command("open")
    .description("Open TAP in the browser")
    .argument("[id]", "Campaign or contact ID (auto-detects type)")
    .option("--url", "Print URL only, do not open browser")
    .action(async (id, opts) => {
      // No ID -- open TAP home
      if (!id) {
        const url = TAP_BASE;
        if (opts.url) {
          console.log(url);
        } else {
          out.success(`Opening TAP`);
          openUrl(url);
        }
        return;
      }

      try {
        const supabase = getClient();

        // Check contacts first (more common use case)
        // Support UUID prefix matching so truncated IDs work
        const { data: contact } = await supabase
          .from("tap_contacts")
          .select("id")
          .ilike("id", `${id}%`)
          .maybeSingle();

        if (contact) {
          const fullId = contact.id;
          const url = `${TAP_BASE}/contacts/${fullId}`;
          if (opts.url) {
            console.log(url);
          } else {
            out.success(`Opening contact ${fullId.slice(0, 8)}...`);
            openUrl(url);
          }
          return;
        }

        // Check campaigns
        // Support UUID prefix matching so truncated IDs work
        const { data: campaign } = await supabase
          .from("tap_projects")
          .select("id")
          .ilike("id", `${id}%`)
          .maybeSingle();

        if (campaign) {
          const fullId = campaign.id;
          const url = `${TAP_BASE}/campaigns/${fullId}`;
          if (opts.url) {
            console.log(url);
          } else {
            out.success(`Opening campaign ${fullId.slice(0, 8)}...`);
            openUrl(url);
          }
          return;
        }

        out.error(`No contact or campaign found with ID: ${id}`);
        process.exit(1);
      } catch (err) {
        handleError(err);
        process.exit(1);
      }
    });
}
