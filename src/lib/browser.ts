/**
 * Cross-platform "open a URL in the default browser" helper.
 *
 * Shared by `tap open` and `tap auth login` (which offers to open the
 * API keys settings page before prompting for a key).
 */

import { exec } from "node:child_process";
import { platform } from "node:os";

function openerFor(os: NodeJS.Platform): string {
  if (os === "darwin") return "open";
  if (os === "win32") return "start \"\"";
  return "xdg-open";
}

/**
 * Open `url` in the user's default browser. Resolves once the spawn has
 * been attempted; `onError` is called (instead of throwing) if the
 * platform opener command fails, so callers can fall back to printing
 * the URL.
 */
export function openUrl(url: string, onError?: (message: string) => void): void {
  const cmd = `${openerFor(platform())} "${url}"`;
  exec(cmd, (err) => {
    if (err && onError) onError(err.message);
  });
}
