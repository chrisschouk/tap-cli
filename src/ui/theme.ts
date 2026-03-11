/**
 * Shared TUI theme: glyphs, colours, and formatting helpers.
 *
 * Matches TAP's visual palette. Same pattern as sink-cli/src/ui/theme.ts.
 */

import chalk from "chalk";

// -- Status glyphs -----------------------------------------------------------
export const GLYPH = {
  check: "\u2713", // ✓
  cross: "\u2717", // ✗
  tilde: "~",
  diamond: "\u25C7", // ◇
  diamondFilled: "\u25C6", // ◆
  bar: "\u2502", // │
  dot: "\u00B7", // ·
  arrow: "\u2192", // →
  divider: "\u2500", // ─
  blockFull: "\u2588", // █
  blockLight: "\u2591", // ░
} as const;

// -- Colour palette (hex) ----------------------------------------------------
// TAP brand palette — calm, professional, trustworthy.
export const COLOUR = {
  primary: "#06b6d4", // cyan-500 (TAP accent)
  success: "#22c55e", // green-500
  danger: "#ef4444", // red-500
  warning: "#eab308", // yellow-500
  muted: "#6b7280", // gray-500
  dimmed: "#374151", // gray-700
  white: "#f9fafb", // gray-50
  secondary: "#b45309", // amber-700 (TAP Pro accent)
} as const;

// -- Pre-coloured glyphs -----------------------------------------------------
export const CHECK = chalk.hex(COLOUR.success)(GLYPH.check);
export const CROSS = chalk.hex(COLOUR.danger)(GLYPH.cross);
export const WARN = chalk.hex(COLOUR.warning)("!");
export const INFO = chalk.hex(COLOUR.primary)(GLYPH.diamond);

// -- Semantic colour maps -----------------------------------------------------
export const WARMTH_COLOUR: Record<string, string> = {
  hot: "#ef4444",
  warm: "#f97316",
  neutral: "#6b7280",
  cold: "#3b82f6",
  over_pitched: "#eab308",
};

export const CONFIDENCE_COLOUR: Record<string, string> = {
  High: "#22c55e",
  Medium: "#eab308",
  Low: "#ef4444",
};

export const PITCH_STATUS_COLOUR: Record<string, string> = {
  not_pitched: COLOUR.dimmed,
  sent: COLOUR.primary,
  opened: "#3b82f6",
  replied: COLOUR.success,
  declined: COLOUR.danger,
  bounced: COLOUR.danger,
};
