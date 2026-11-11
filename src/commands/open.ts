/**
 * Open command -- open TAP in the browser from the terminal.
 *
 * Usage:
 *   tap open                    # open TAP home
 *   tap open <id>               # detect type and open correct page
 *   tap open <id> --url         # print URL only
 */

import { Command } from "commander";
import { restRequest } from "../lib/rest.js";
import { openUrl } from "../lib/browser.js";
import { dashboard } from "../lib/dashboard.js";
import * as out from "../output.js";
import { handleError } from "../ui/errors.js";

function openInBrowser(url: string): void {
  openUrl(url, (message) => {
    out.error(`Failed to open browser: ${message}`);
    out.info(`URL: ${url}`);
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
        const url = dashboard.home();
        if (opts.url) {
          console.log(url);
        } else {
          out.success(`Opening TAP`);
          openInBrowser(url);
        }
        return;
      }

      try {
        let resolvedUrl: string | null = null;
        let fullId = id;

        // If id is shorter than 36, try fetching lists and looking for prefix
        if (id.length < 36) {
          // Check contacts first
          const contactsRes = await restRequest<{ contacts: any[] }>("/api/v1/contacts", {
            query: { limit: 100 },
          });
          const foundContact = contactsRes.contacts.find(c => c.id.startsWith(id));
          if (foundContact) {
            fullId = foundContact.id;
            resolvedUrl = dashboard.contact(fullId);
          } else {
            // Check campaigns
            const campaignsRes = await restRequest<{ campaigns: any[] }>("/api/v1/campaigns");
            const foundCampaign = campaignsRes.campaigns.find(c => c.id.startsWith(id));
            if (foundCampaign) {
              fullId = foundCampaign.id;
              resolvedUrl = dashboard.release(fullId);
            }
          }
        } else {
          // Full UUID, try querying contact detail
          try {
            await restRequest(`/api/v1/contacts/${encodeURIComponent(id)}`);
            resolvedUrl = dashboard.contact(id);
          } catch {
            try {
              await restRequest(`/api/v1/campaigns/${encodeURIComponent(id)}`);
              resolvedUrl = dashboard.release(id);
            } catch {
              resolvedUrl = null;
            }
          }
        }

        if (resolvedUrl) {
          if (opts.url) {
            console.log(resolvedUrl);
          } else {
            out.success(`Opening TAP item ${fullId.slice(0, 8)}...`);
            openInBrowser(resolvedUrl);
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
