/**
 * Discover command. Contact discovery is not in TAP REST v1, so this points
 * at the contacts page in TAP.
 */

import { dashboard } from "../lib/dashboard.js";
import { linkOutCommand } from "../ui/link-out.js";

export function discoverCommand() {
  return linkOutCommand({
    name: "discover",
    description: "Discover new contacts",
    argument: { name: "query", description: "Search text" },
    reason: "Contact discovery is not in the TAP API yet. Find and add contacts in TAP.",
    url: () => dashboard.contacts(),
  });
}
