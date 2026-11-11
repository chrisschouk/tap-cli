/**
 * TAP dashboard URLs. Paths follow the page routes in apps/tap/app.
 * Approving and sending a pitch happen only on the release's pitching tab.
 */

import { getTapUrl } from "./rest.js";

export const dashboard = {
  home: () => `${getTapUrl()}/home`,
  releases: () => `${getTapUrl()}/releases`,
  release: (id: string) => `${getTapUrl()}/releases/${encodeURIComponent(id)}`,
  approveAndSend: (campaignId: string) =>
    `${getTapUrl()}/releases/${encodeURIComponent(campaignId)}?tab=pitching#waiting-on-you`,
  contacts: () => `${getTapUrl()}/contacts`,
  contact: (id: string) => `${getTapUrl()}/contacts/${encodeURIComponent(id)}`,
};
