/**
 * Send command -- shows the pitches for a campaign that still need the artist,
 * and where to approve and send them in TAP.
 *
 * Approving and sending a pitch are human-only in TAP. This command never
 * approves or sends; it lists what is waiting and links to the release's
 * pitching tab, where the artist approves and TAP sends.
 *
 * To ask for approval from the terminal and answer on a phone, see `tap approve`.
 *
 * Usage:
 *   tap send <campaign-id>           -- list waiting pitches and print the TAP link
 *   tap send <campaign-id> --open    -- also open the link in the browser
 */

import { Command } from "commander";
import chalk from "chalk";
import { restRequest } from "../lib/rest.js";
import { dashboard } from "../lib/dashboard.js";
import { openUrl } from "../lib/browser.js";
import {
  fetchPendingPitches,
  PENDING_STATE_LABEL,
  type PendingPitch,
  type PendingState,
} from "../lib/pending-pitches.js";
import * as out from "../output.js";
import { COLOUR } from "../ui/theme.js";
import { campaignLabel, navHint, shortDate } from "../ui/detail.js";
import { createRailSpinner, blank, summaryBar } from "../ui/format.js";
import { handleError } from "../ui/errors.js";

interface CampaignRow {
  id: string;
  name: string;
  artist_name: string | null;
}

const STATE_COLOUR: Record<PendingState, string> = {
  draft: COLOUR.muted,
  pending_approval: COLOUR.warning,
  approved: COLOUR.success,
  send_failed: COLOUR.danger,
  held_for_payment: COLOUR.warning,
};

const waitingCount = (pending: PendingPitch[]) => pending.filter((p) => p.state === "pending_approval").length;

function renderPending(pitches: PendingPitch[]): void {
  const rows = pitches.map((p) => [
    out.truncate(p.subject, 40) || "",
    chalk.hex(STATE_COLOUR[p.state])(PENDING_STATE_LABEL[p.state]),
    shortDate(p.scheduledFor),
  ]);
  blank();
  out.table(["Subject", "State", "Scheduled"], rows);
}

export function sendCommand(): Command {
  return new Command("send")
    .description("List a campaign's pitches waiting for approval and link to where you approve and send them in TAP")
    .argument("<campaign-id>", "Campaign ID")
    .option("--open", "Open the approve-and-send page in your browser")
    .option("--json", "Output as JSON")
    .action(async (campaignId: string, opts: { open?: boolean; json?: boolean }) => {
      const rail = createRailSpinner("Loading pitches").start();

      try {
        const [{ campaign }, pending] = await Promise.all([
          restRequest<{ campaign: CampaignRow }>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}`),
          fetchPendingPitches(campaignId),
        ]);
        const url = dashboard.approveAndSend(campaign.id);

        if (opts.json) {
          rail.stop();
          out.json({ campaign_id: campaign.id, pitches: pending, approve_url: url });
          return;
        }

        rail.succeed("Loaded", `${campaignLabel(campaign)}, ${pending.length} pitches still need you`);

        if (pending.length === 0) {
          out.info("Nothing is waiting for approval in this campaign");
        } else {
          renderPending(pending);
        }

        blank();
        out.info("Approve and send in TAP. The CLI never sends a pitch.");
        console.log(`  ${chalk.hex(COLOUR.primary)(url)}`);
        if (waitingCount(pending) > 0) out.info(`Or ask from here and approve on your phone: tap approve ${campaign.id}`);
        if (opts.open) openUrl(url, (message) => out.error(`Failed to open browser: ${message}`));

        blank();
        summaryBar([`${pending.length} waiting`, campaignLabel(campaign)]);
        navHint([`tap approve ${campaignId}`, `tap send ${campaignId} --open`, `tap campaigns show ${campaignId}`]);
        blank();
      } catch (err) {
        rail.fail("Could not load pitches");
        handleError(err);
        process.exit(1);
      }
    });
}
