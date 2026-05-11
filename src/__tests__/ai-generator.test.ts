import { describe, it, expect } from "vitest";
import { parseResponse } from "../lib/ai-generator.js";

// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------

describe("parseResponse", () => {
  const wellFormed = `
---SUBJECT---
New music from The Remedy
---VARIANT 1---
Hi Sarah, I wanted to share The Remedy's new single "Drift" with you. It's a driving indie-rock track that I think fits perfectly with BBC 6 Music's afternoon programming. Happy to send over a link if useful.
---VARIANT 2---
The Remedy started as a bedroom project in Sheffield three years ago. "Drift" is the track where everything clicked — layered guitars, restrained vocals, and a hook that earworms its way in after one listen. Worth a spin for BBC 6?
---VARIANT 3---
I know you cover British guitar bands at BBC 6 Music — The Remedy's "Drift" sits right in that sweet spot between Fontaines D.C. and early Bombay Bicycle Club. Exclusive first-play available if you're interested.
---END---
`;

  it("extracts subject from a well-formed response", () => {
    const result = parseResponse(wellFormed);
    expect(result.subject).toBe("New music from The Remedy");
  });

  it("extracts body (variant 1) from a well-formed response", () => {
    const result = parseResponse(wellFormed);
    expect(result.body).toContain("Hi Sarah");
    expect(result.body).toContain('"Drift"');
  });

  it("extracts all three variants from a well-formed response", () => {
    const result = parseResponse(wellFormed);
    expect(result.variants).toBeDefined();
    expect(result.variants!.direct).toContain("Hi Sarah");
    expect(result.variants!.story).toContain("bedroom project");
    expect(result.variants!.value).toContain("Exclusive first-play");
  });

  it("trims leading and trailing whitespace from each variant", () => {
    const result = parseResponse(wellFormed);
    expect(result.variants!.direct).toBe(result.variants!.direct.trim());
    expect(result.variants!.story).toBe(result.variants!.story.trim());
    expect(result.variants!.value).toBe(result.variants!.value.trim());
  });

  it("uses fallback subject when ---SUBJECT--- delimiter is missing", () => {
    const noSubject = `
---VARIANT 1---
Body text here.
---VARIANT 2---
Story variant.
---VARIANT 3---
Value variant.
---END---
`;
    const result = parseResponse(noSubject);
    expect(result.subject).toBe("New music for your consideration");
  });

  it("sets variants to undefined when variant 2 and 3 are both empty", () => {
    // Only variant 1 present — story and value will be empty strings
    const oneVariant = `
---SUBJECT---
Short subject
---VARIANT 1---
Just one body here.
---VARIANT 2---
---VARIANT 3---
---END---
`;
    const result = parseResponse(oneVariant);
    expect(result.variants).toBeUndefined();
    expect(result.body).toBe("Just one body here.");
  });

  it("falls back to full trimmed text as body when no variant delimiters exist", () => {
    const malformed = "This is just a plain response with no delimiters at all.";
    const result = parseResponse(malformed);
    expect(result.body).toBe(malformed.trim());
    expect(result.subject).toBe("New music for your consideration");
  });

  it("handles extra whitespace around delimiter tags", () => {
    const extraSpace = `
---SUBJECT---

  Spaced Subject Line

---VARIANT 1---

  Body with leading whitespace.

---VARIANT 2---

  Story with space.

---VARIANT 3---

  Value with space.

---END---
`;
    const result = parseResponse(extraSpace);
    expect(result.subject).toBe("Spaced Subject Line");
    expect(result.body).toBe("Body with leading whitespace.");
    expect(result.variants!.story).toBe("Story with space.");
    expect(result.variants!.value).toBe("Value with space.");
  });

  it("returns an object with the expected shape for any input", () => {
    const result = parseResponse("totally random text");
    expect(result).toHaveProperty("subject");
    expect(result).toHaveProperty("body");
    expect(typeof result.subject).toBe("string");
    expect(typeof result.body).toBe("string");
  });
});
