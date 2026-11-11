/**
 * Stats command. TAP has no workspace statistics endpoint in REST v1, so this
 * points at the Home page, which shows the same numbers.
 */

import { dashboard } from "../lib/dashboard.js";
import { linkOutCommand } from "../ui/link-out.js";

export function statsCommand() {
  return linkOutCommand({
    name: "stats",
    description: "Show workspace statistics",
    reason: "Workspace statistics are not in the TAP API yet. See them on your TAP home page.",
    url: () => dashboard.home(),
  });
}
