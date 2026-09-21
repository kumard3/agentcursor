import { describe, expect as vexpect, it } from "vitest";
import type { ActionService } from "../src/action/service";
import type { LocatorMatch } from "../src/protocol";
import { expect } from "../src/sdk/expect";
import { Locator } from "../src/sdk/locator";

const match = (text: string, visible = true): LocatorMatch => ({
  handle: "loc1",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  count: 1,
  visible,
  text,
});

/** A locator whose page changes over time: returns each match in turn, then sticks on the last. */
function pageLocator(...frames: LocatorMatch[]): Locator {
  let i = 0;
  const action = { resolveLocator: async () => frames[Math.min(i++, frames.length - 1)] };
  return new Locator({ action: action as unknown as ActionService, stealth: false }, [{ kind: "css", value: "#banner" }]);
}

describe("expect", () => {
  it("retries until the page catches up", async () => {
    await expect(pageLocator(match("loading"), match("loading"), match("Saved  !"))).toHaveText("Saved !");
  });

  it("fails with the locator and last value after the timeout", async () => {
    await vexpect(expect(pageLocator(match("loading")), { timeout: 200 }).toContainText("Saved")).rejects.toThrow(
      /locator \[css=#banner\]\)\.toContainText\(Saved\) failed after 200ms, got "loading"/,
    );
  });

  it("not flips the check and still retries", async () => {
    await expect(pageLocator(match("menu", true), match("menu", false))).not.toBeVisible();
    await vexpect(expect(pageLocator(match("x", false)), { timeout: 150 }).not.toBeHidden()).rejects.toThrow(/not\.toBeHidden/);
  });

  it("regex and count", async () => {
    await expect(pageLocator(match("Order #1042 placed"))).toHaveText(/#\d+ placed/);
    await expect(pageLocator({ ...match(""), count: 3 })).toHaveCount(3);
  });
});
