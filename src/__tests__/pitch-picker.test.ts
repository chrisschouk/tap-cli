import { describe, it, expect } from "vitest";
import { initialPicker, renderPicker, stepPicker, type PickerKey, type PickerPitch } from "../ui/pitch-picker.js";

const pitches: PickerPitch[] = [
  { id: "a", subject: "Night Drive for your Friday show", body: "Hi Jo,\n\nNight Drive is out 1 December. It is a slow, late-night track.\n\nStems are on request." },
  { id: "b", subject: "Night Drive, a late one for NTS", body: "Hi Maya," },
];

const press = (...keys: PickerKey[]) => keys.reduce((s, k) => stepPicker(s, k, pitches), initialPicker(pitches));

describe("pitch picker", () => {
  it("starts with every pitch chosen and asks with enter", () => {
    expect(press("ask")).toMatchObject({ done: "ask", chosen: new Set(["a", "b"]) });
  });

  it("toggles the focused pitch and wraps the cursor", () => {
    expect(press("down", "toggle").chosen).toEqual(new Set(["a"]));
    expect(press("up").cursor).toBe(1);
  });

  it("clears then restores everything with a, and will not ask about nothing", () => {
    const none = press("all");
    expect(none.chosen.size).toBe(0);
    expect(stepPicker(none, "ask", pitches).done).toBeNull();
    expect(stepPicker(none, "all", pitches).chosen.size).toBe(2);
  });

  it("shows the focused pitch's full body when reading", () => {
    const text = renderPicker(press("read"), pitches, 80).join("\n");
    expect(text).toContain("Stems are on request.");
    expect(text).toContain("2 of 2 chosen");
    expect(renderPicker(press(), pitches, 80).join("\n")).not.toContain("Stems are on request.");
  });
});
