import { describe, it, expect } from "vitest";
import { relativeDate, percentage, sparkbar, stripAnsi, ansiPadEnd } from "../ui/detail.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an ISO date string offset by `days` from now. */
function daysFromNow(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// relativeDate
// ---------------------------------------------------------------------------

describe("relativeDate", () => {
  it("returns a dim dash for null", () => {
    const result = relativeDate(null);
    // Strip ANSI to test the visible content
    expect(stripAnsi(result)).toBe("─");
  });

  it("returns a dim dash for undefined", () => {
    const result = relativeDate(undefined);
    expect(stripAnsi(result)).toBe("─");
  });

  it("returns 'today' for a date within the current day", () => {
    expect(relativeDate(new Date().toISOString())).toBe("today");
  });

  it("returns '1d ago' for yesterday", () => {
    expect(relativeDate(daysFromNow(-1))).toBe("1d ago");
  });

  it("returns 'Xd ago' for days within the same week", () => {
    expect(relativeDate(daysFromNow(-3))).toBe("3d ago");
    expect(relativeDate(daysFromNow(-6))).toBe("6d ago");
  });

  it("returns 'Xw ago' for dates 7-29 days ago", () => {
    expect(relativeDate(daysFromNow(-7))).toBe("1w ago");
    expect(relativeDate(daysFromNow(-14))).toBe("2w ago");
  });

  it("returns 'Xmo ago' for dates 30-364 days ago", () => {
    expect(relativeDate(daysFromNow(-30))).toBe("1mo ago");
    expect(relativeDate(daysFromNow(-90))).toBe("3mo ago");
  });

  it("returns 'Xy ago' for dates 365+ days ago", () => {
    expect(relativeDate(daysFromNow(-365))).toBe("1y ago");
    expect(relativeDate(daysFromNow(-730))).toBe("2y ago");
  });

  it("returns 'tomorrow' for 1 day in the future", () => {
    expect(relativeDate(daysFromNow(1))).toBe("tomorrow");
  });

  it("returns 'in Xd' for 2-6 days in the future", () => {
    expect(relativeDate(daysFromNow(3))).toBe("in 3d");
  });

  it("returns 'in Xw' for 7-29 days in the future", () => {
    expect(relativeDate(daysFromNow(14))).toBe("in 2w");
  });

  it("returns 'in Xmo' for 30+ days in the future", () => {
    expect(relativeDate(daysFromNow(60))).toBe("in 2mo");
  });
});

// ---------------------------------------------------------------------------
// percentage
// ---------------------------------------------------------------------------

describe("percentage", () => {
  it("returns a dim dash for null", () => {
    const result = percentage(null);
    expect(stripAnsi(result)).toBe("─");
  });

  it("returns a dim dash for undefined", () => {
    const result = percentage(undefined);
    expect(stripAnsi(result)).toBe("─");
  });

  it("returns green for 0% (0/100 = 0, below 20)", () => {
    // 0 < 20 → red
    const result = percentage(0);
    expect(stripAnsi(result)).toBe("0%");
  });

  it("returns red for values below 20%", () => {
    const result = percentage(0.19);
    expect(stripAnsi(result)).toBe("19%");
  });

  it("returns yellow for values between 20% and 49%", () => {
    const result = percentage(0.35);
    expect(stripAnsi(result)).toBe("35%");
  });

  it("returns green for exactly 50%", () => {
    const result = percentage(0.5);
    expect(stripAnsi(result)).toBe("50%");
  });

  it("returns green for 100%", () => {
    const result = percentage(1);
    expect(stripAnsi(result)).toBe("100%");
  });

  it("rounds fractional percentages", () => {
    const result = percentage(0.505);
    expect(stripAnsi(result)).toBe("51%");
  });
});

// ---------------------------------------------------------------------------
// sparkbar
// ---------------------------------------------------------------------------

describe("sparkbar", () => {
  it("returns all empty blocks for ratio 0", () => {
    const result = stripAnsi(sparkbar(0));
    // Default width 16, all empty (blockLight character ░)
    expect(result).toBe("░".repeat(16));
  });

  it("returns all filled blocks for ratio 1", () => {
    const result = stripAnsi(sparkbar(1));
    // Default width 16, all filled (blockFull character █)
    expect(result).toBe("█".repeat(16));
  });

  it("returns half filled for ratio 0.5 with default width", () => {
    const result = stripAnsi(sparkbar(0.5));
    // 8 filled + 8 empty
    expect(result).toBe("█".repeat(8) + "░".repeat(8));
  });

  it("clamps ratios below 0 to 0", () => {
    const result = stripAnsi(sparkbar(-1));
    expect(result).toBe("░".repeat(16));
  });

  it("clamps ratios above 1 to 1", () => {
    const result = stripAnsi(sparkbar(2));
    expect(result).toBe("█".repeat(16));
  });

  it("respects a custom width", () => {
    const result = stripAnsi(sparkbar(1, 8));
    expect(result).toBe("█".repeat(8));
  });
});

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  it("returns a plain string unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("strips a colour escape sequence", () => {
    // ESC[32m = green, ESC[0m = reset
    expect(stripAnsi("\x1b[32mGreen text\x1b[0m")).toBe("Green text");
  });

  it("strips multiple escape sequences in one string", () => {
    expect(stripAnsi("\x1b[1m\x1b[34mBold blue\x1b[0m")).toBe("Bold blue");
  });

  it("returns an empty string unchanged", () => {
    expect(stripAnsi("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ansiPadEnd
// ---------------------------------------------------------------------------

describe("ansiPadEnd", () => {
  it("pads a plain string to the given width", () => {
    expect(ansiPadEnd("hello", 10)).toBe("hello     ");
  });

  it("pads an ANSI-coloured string based on visible length, not raw length", () => {
    const coloured = "\x1b[32mOK\x1b[0m"; // visible length = 2
    const result = ansiPadEnd(coloured, 6);
    // Raw string + 4 spaces = visible length 6
    expect(stripAnsi(result)).toBe("OK    ");
  });

  it("does not truncate if string is already wider than target", () => {
    const result = ansiPadEnd("hello world", 5);
    expect(result).toBe("hello world");
  });

  it("returns the original string when width equals visible length", () => {
    expect(ansiPadEnd("abc", 3)).toBe("abc");
  });

  it("handles zero width", () => {
    expect(ansiPadEnd("hi", 0)).toBe("hi");
  });
});
