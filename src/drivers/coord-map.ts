import type { Point, WindowGeometry } from "../protocol";

/**
 * Page viewport (CSS px) <-> OS screen coordinates. Assumes 100% browser zoom
 * (1 CSS px ≈ 1 screen point) and the toolbar/title bar sitting above the
 * viewport. devicePixelRatio is reported for callers that need device pixels.
 * Known limitation: multi-monitor and fractional scaling can be off; use at 100% zoom.
 */

function chromeOffsets(g: WindowGeometry): { left: number; top: number } {
  return {
    left: Math.max(0, (g.outerWidth - g.innerWidth) / 2),
    top: g.outerHeight - g.innerHeight,
  };
}

export function viewportToScreen(p: Point, g: WindowGeometry): Point {
  const { left, top } = chromeOffsets(g);
  return { x: g.screenX + left + p.x, y: g.screenY + top + p.y };
}

export function screenToViewport(p: Point, g: WindowGeometry): Point {
  const { left, top } = chromeOffsets(g);
  return { x: p.x - g.screenX - left, y: p.y - g.screenY - top };
}
