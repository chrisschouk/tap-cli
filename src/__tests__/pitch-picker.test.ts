import { describe, it, expect } from "vitest";
import { initialPicker, listWindow, renderPicker, stepPicker, type PickerKey, type PickerPitch } from "../ui/pitch-picker.js";
import { toPendingPitches } from "../lib/pending-pitches.js";

const pitches: PickerPitch[] = [
  { id: "a", subject: "Night Drive for your Friday show", body: "Hi Jo,\n\nNight Drive is out 1 December. It is a slow, late-night track.\n\nStems are on request.", recipient: null },
  { id: "b", subject: "Night Drive, a late one for NTS", body: "Hi Maya,", recipient: null },
];

const view = { width: 80, height: 24 };
const press = (...keys: PickerKey[]) => keys.reduce((s, k) => stepPicker(s, k, pitches), initialPicker(pitches));
const text = (lines: string[]) => lines.join("\n");

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

  it("shows the focused pitch's full body when reading, and says what the read view leaves out", () => {
    const reading = text(renderPicker(press("read"), pitches, view));
    expect(reading).toContain("Stems are on request.");
    expect(reading).toContain("2 of 2 chosen");
    expect(reading).toContain("the release block TAP adds below the body, and the sender");
    expect(text(renderPicker(press(), pitches, view))).not.toContain("Stems are on request.");
  });

  it("says recipients appear once asked, and that c withdraws, while the API sends none", () => {
    expect(text(renderPicker(press(), pitches, view))).toContain("TAP lists who each pitch goes to once you ask. If one is wrong, press c");
  });

  it("fits 50 pitches into a 24-row terminal and scrolls with the cursor", () => {
    const many: PickerPitch[] = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, subject: `Pitch ${i + 1}`, body: "Hi,", recipient: null }));
    const at = (n: number) => Array.from({ length: n }, () => "down" as PickerKey).reduce((s, k) => stepPicker(s, k, many), initialPicker(many));
    const top = renderPicker(at(0), many, view);
    expect(top.length).toBeLessThan(24);
    expect(text(top)).toContain("Pitch 1");
    expect(text(top)).toMatch(/↓ \d+ more/);
    const middle = text(renderPicker(at(30), many, view));
    expect(middle).toContain("Pitch 31");
    expect(middle).not.toContain("Pitch 1\n");
    expect(middle).toMatch(/↑ \d+ more/);
    expect(renderPicker(stepPicker(at(30), "read", many), many, view).length).toBeLessThan(24);
    expect(listWindow(50, 49, 7)).toEqual([43, 50]);
  });
});

describe("recipients from the pitches route", () => {
  const queue = [{ id: "a", state: "pending_approval", send_status: "draft", scheduled_for: null }];

  it("reads to, contact_name and outlet when TAP sends them, and shows them in the chooser", () => {
    const [pitch] = toPendingPitches([{ id: "a", title: null, subject: "Night Drive", body: "Hi Jo,", to: "jo@bbc.co.uk", contact_name: "Jo Presenter", outlet: "BBC Radio 6 Music" }], queue);
    expect(pitch.recipient).toEqual({ to: "jo@bbc.co.uk", name: "Jo Presenter", outlet: "BBC Radio 6 Music" });
    const lines = text(renderPicker(initialPicker([pitch]), [pitch], view));
    expect(lines).toContain("To Jo Presenter <jo@bbc.co.uk>, BBC Radio 6 Music");
    expect(lines).not.toContain("once you ask");
  });

  it("has no recipient when the route leaves the fields out", () => {
    const [pitch] = toPendingPitches([{ id: "a", title: null, subject: "Night Drive", body: "Hi" }], queue);
    expect(pitch.recipient).toBeNull();
  });
});
