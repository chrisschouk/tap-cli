/**
 * Watch command. TAP has no activity feed endpoint in REST v1, so this points
 * at the release's activity tab, or the release list for the whole workspace.
 */

import { dashboard } from "../lib/dashboard.js";
import { linkOutCommand } from "../ui/link-out.js";

export function watchCommand() {
  return linkOutCommand({
    name: "watch",
    description: "Live campaign monitor",
    argument: { name: "campaign-id", description: "Campaign ID for focused view" },
    reason: "Live campaign activity is not in the TAP API yet. Follow it in TAP.",
    url: (campaignId) =>
      campaignId ? `${dashboard.release(campaignId)}?tab=activity` : dashboard.releases(),
  });
}
