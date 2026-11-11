/**
 * Centralised error formatting.
 *
 * Transforms TAP API and Node errors into friendly terminal messages
 * with contextual hints for resolution.
 */

import chalk from "chalk";
import { GLYPH } from "./theme.js";
import { TapApiError } from "../lib/rest.js";

interface FormattedError {
  message: string;
  hint?: string;
}

/**
 * Thrown in place of `process.exit` while interactive mode runs a command, so
 * a failing command ends that command and not the session.
 */
export class CommandExit extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
    this.name = "CommandExit";
  }
}

const API_STATUS_HINT: Record<number, string> = {
  401: "Run `tap auth login` with a current tap_ak_ key.",
  402: "The TAP API needs the year plan. See https://totalaudiopromo.com/settings/billing.",
  404: "Check the ID and try again.",
  429: "Rate limit reached. Wait a minute and try again.",
};

/** TAP answers a missing scope with "Insufficient scope: <scope> required". */
function apiHint(err: TapApiError): string | undefined {
  const scope = /Insufficient scope: (\S+) required/.exec(err.message)?.[1];
  if (scope) return `Mint a key with ${scope} in Settings, API keys, then run \`tap auth login\`.`;
  return API_STATUS_HINT[err.status];
}

function formatError(err: unknown): FormattedError {
  if (!(err instanceof Error)) {
    return { message: "Unknown error" };
  }

  if (err instanceof TapApiError) {
    return { message: err.message, hint: apiHint(err) };
  }

  const msg = err.message;
  const code = (err as NodeJS.ErrnoException).code;

  // File system errors
  if (code === "ENOENT") {
    const match = msg.match(/open '(.+)'/);
    const path = match?.[1] || "file";
    return {
      message: `File not found: ${path}`,
      hint: "Check the path and try again.",
    };
  }

  if (code === "EISDIR") {
    const match = msg.match(/read '(.+)'/);
    const path = match?.[1] || "path";
    return {
      message: `That's a directory, not a file: ${path}`,
      hint: "Pass a CSV or JSON file path instead.",
    };
  }

  if (code === "EACCES") {
    return {
      message: "Permission denied",
      hint: "Check file permissions and try again.",
    };
  }

  // Network errors
  if (code === "ECONNREFUSED" || msg.includes("ECONNREFUSED")) {
    return {
      message: "Cannot connect to TAP",
      hint: "Check your internet connection and try again.",
    };
  }

  if (msg.includes("fetch failed") || msg.includes("network")) {
    return {
      message: "Network error",
      hint: "Check your internet connection and try again.",
    };
  }

  // Auth errors
  if (msg.includes("401") || msg.includes("not authenticated")) {
    return {
      message: "Authentication failed",
      hint: "Run `tap auth login` to reconnect.",
    };
  }

  if (msg.includes("403") || msg.includes("permission")) {
    return {
      message: "Access denied",
      hint: "Check your workspace permissions.",
    };
  }

  // Default: just the message
  return { message: msg };
}

/**
 * Print a formatted error with optional hint line.
 */
export function handleError(err: unknown): void {
  if (err instanceof CommandExit) throw err;
  const { message, hint } = formatError(err);
  console.error(`  ${chalk.red(GLYPH.cross)} ${message}`);
  if (hint) {
    console.error(`  ${chalk.dim(hint)}`);
  }
}
