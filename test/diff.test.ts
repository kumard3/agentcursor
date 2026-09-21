import { describe, expect, it } from "vitest";
import { diffRead, readOrDiff } from "../src/util/diff";

const page = ['[e1] button "Like" @78,295', '[e2] button "Reply" @83,341'];

describe("diffRead", () => {
  it("reports nothing when the read is identical", () => {
    expect(diffRead(page, [...page])).toBe("no change since the last read");
  });

  it("reports added and removed lines with a total", () => {
    const next = [page[0]!, '[e9] button "Settings" @120,300'];
    expect(diffRead(page, next)).toBe(
      `- [e2] button "Reply" @83,341\n+ [e9] button "Settings" @120,300\n(1 unchanged, 2 total)`,
    );
  });

  it("counts elements that only moved instead of listing them", () => {
    const shifted = page.map((l) => l.replace(/@(\d+),(\d+)/, (_m, x, y) => `@${x},${Number(y) + 23}`));
    expect(diffRead(page, shifted)).toBe("(2 moved, 0 unchanged, 2 total)");
  });

  it("shows a changed value as the old line out and the new line in", () => {
    const before = ['[e5] text "Email" @293,300'];
    const after = ['[e5] text "Email" value="a@b.com" @293,300'];
    expect(diffRead(before, after)).toContain('+ [e5] text "Email" value="a@b.com" @293,300');
    expect(diffRead(before, after)).toContain('- [e5] text "Email" @293,300');
  });

  it("counts duplicate lines rather than collapsing them", () => {
    expect(diffRead(["row", "row"], ["row"])).toBe("- row\n(1 unchanged, 1 total)");
  });

  it("falls back to the full read with no baseline or when the diff is not smaller", () => {
    expect(readOrDiff(undefined, page)).toBe(page.join("\n"));
    expect(readOrDiff(["x"], page)).toBe(page.join("\n"));
  });

  it("uses the diff when it is smaller", () => {
    const many = Array.from({ length: 40 }, (_, i) => `[e${i}] button "b${i}" @0,${i}`);
    const next = [...many, '[e99] button "New" @0,99'];
    expect(readOrDiff(many, next)).toBe('+ [e99] button "New" @0,99\n(40 unchanged, 41 total)');
  });
});
