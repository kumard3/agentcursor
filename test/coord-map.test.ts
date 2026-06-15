import { describe, expect, it } from "vitest";
import type { WindowGeometry } from "../src/protocol";
import { screenToViewport, viewportToScreen } from "../src/drivers/coord-map";

const geom: WindowGeometry = {
  screenX: 120,
  screenY: 80,
  innerWidth: 1200,
  innerHeight: 700,
  outerWidth: 1200,
  outerHeight: 788,
  devicePixelRatio: 2,
};

describe("coord-map", () => {
  it("maps a viewport point to screen with the chrome offset", () => {
    const screen = viewportToScreen({ x: 100, y: 50 }, geom);
    // left chrome = 0, top chrome = outerHeight - innerHeight = 88
    expect(screen).toEqual({ x: 220, y: 218 });
  });

  it("round-trips viewport -> screen -> viewport", () => {
    const p = { x: 642, y: 333 };
    const back = screenToViewport(viewportToScreen(p, geom), geom);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it("accounts for symmetric horizontal chrome when present", () => {
    const g: WindowGeometry = { ...geom, outerWidth: 1220, innerWidth: 1200 };
    const screen = viewportToScreen({ x: 0, y: 0 }, g);
    expect(screen.x).toBe(geom.screenX + 10);
  });
});
