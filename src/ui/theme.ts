/**
 * Shared TUI theme: glyphs, colours, and formatting helpers.
 *
 * Matches TAP's visual palette. Same pattern as sink-cli/src/ui/theme.ts.
 */

// -- Status glyphs -----------------------------------------------------------
export const GLYPH = {
  check: "\u2713", // ✓
  cross: "\u2717", // ✗
  tilde: "~",
  diamond: "\u25C7", // ◇
  bar: "\u2502", // │
  dot: "\u00B7", // ·
  arrow: "\u2192", // →
  divider: "\u2500", // ─
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
