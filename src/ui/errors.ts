/**
 * Centralised error formatting.
 *
 * Transforms raw Node/Supabase errors into friendly terminal messages
 * with contextual hints for resolution.
 */

import chalk from "chalk";
import { GLYPH } from "./theme.js";

interface FormattedError {
  message: string;
  hint?: string;
}

function formatError(err: unknown): FormattedError {
  if (!(err instanceof Error)) {
    return { message: "Unknown error" };
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
  if (msg.includes("JWT") || msg.includes("401") || msg.includes("not authenticated")) {
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

  // Supabase errors
  if (msg.includes("23505") || msg.includes("duplicate key")) {
    return {
      message: "Already exists",
      hint: "This record already exists in your workspace.",
    };
  }

  if (msg.includes("PGRST")) {
    return {
      message: "Database error",
      hint: msg,
    };
  }

  // Gmail errors
  if (msg.includes("Gmail") || msg.includes("gmail")) {
    return { message: msg };
  }

  // Default: just the message
  return { message: msg };
}

/**
 * Print a formatted error with optional hint line.
 */
export function handleError(err: unknown): void {
  const { message, hint } = formatError(err);
  console.error(`  ${chalk.red(GLYPH.cross)} ${message}`);
  if (hint) {
    console.error(`  ${chalk.dim(hint)}`);
  }
}
