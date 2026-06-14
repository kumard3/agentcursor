import { clamp, smootherstep } from "./geometry";
import type { Rng } from "./rng";

/** Fitts's law (Shannon form): duration grows with the index of difficulty. */
export function fittsDurationMs(
  dist: number,
  targetWidth: number,
  rng: Rng,
): number {
  const a = rng.range(70, 130);
  const b = rng.range(80, 150);
  const id = Math.log2(dist / Math.max(targetWidth, 6) + 1);
  return Math.max(90, a + b * id);
}

export function stepCount(durationMs: number, rng: Rng): number {
  return Math.round(clamp(durationMs / rng.range(14, 20), 8, 140));
}

/**
 * Map normalized time -> normalized distance with a smootherstep eased by a
 * per-move skew exponent, so peak velocity is not pinned to the midpoint.
 */
export function easeParam(timeFraction: number, skew: number): number {
  return Math.pow(smootherstep(timeFraction), skew);
}
