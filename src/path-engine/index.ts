import type { CursorSample, Point, Rect } from "../protocol";
import { clamp, cubicBezier, distance } from "./geometry";
import { easeParam, fittsDurationMs, stepCount } from "./profile";
import { createRng, type Rng } from "./rng";

export { createRng } from "./rng";
export type { Rng } from "./rng";

export interface MoveOptions {
  rng?: Rng;
  /** approximate target size, feeds Fitts duration; default 24 */
  targetWidth?: number;
  /** Gaussian jitter amplitude in px; default 1.4 */
  jitter?: number;
  /** allow overshoot-and-correct on long moves; default true */
  overshoot?: boolean;
}

const OVERSHOOT_MIN_DISTANCE = 180;
const OVERSHOOT_PROB = 0.5;

export function generateMove(
  from: Point,
  to: Point,
  options: MoveOptions = {},
): CursorSample[] {
  const rng = options.rng ?? createRng();
  const targetWidth = options.targetWidth ?? 24;
  const jitterAmp = options.jitter ?? 1.4;
  const allowOvershoot = options.overshoot ?? true;
  const total = distance(from, to);

  const legs: Array<{ a: Point; b: Point; correction: boolean }> = [];
  if (
    allowOvershoot &&
    total > OVERSHOOT_MIN_DISTANCE &&
    rng.bool(OVERSHOOT_PROB)
  ) {
    const past = overshootPoint(from, to, rng);
    legs.push({ a: from, b: past, correction: false });
    legs.push({ a: past, b: to, correction: true });
  } else {
    legs.push({ a: from, b: to, correction: false });
  }

  const samples: CursorSample[] = [];
  let tOffset = 0;
  for (const leg of legs) {
    const seg = buildSegment(leg.a, leg.b, rng, {
      targetWidth,
      jitterAmp,
      correction: leg.correction,
    });
    for (const s of seg) samples.push({ x: s.x, y: s.y, t: s.t + tOffset });
    const last = samples.at(-1);
    tOffset = (last?.t ?? tOffset) + rng.range(12, 45);
  }

  return monotonic(samples);
}

interface SegmentOptions {
  targetWidth: number;
  jitterAmp: number;
  correction: boolean;
}

function buildSegment(
  a: Point,
  b: Point,
  rng: Rng,
  opts: SegmentOptions,
): CursorSample[] {
  const dist = distance(a, b);
  const baseDuration = fittsDurationMs(
    dist,
    opts.correction ? Math.max(opts.targetWidth, 12) : opts.targetWidth,
    rng,
  );
  const duration = baseDuration * (opts.correction ? 0.55 : 1);
  const steps = stepCount(duration, rng);
  const skew = rng.range(0.85, 1.18);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(Math.hypot(dx, dy), 1e-4);
  const nx = -dy / len;
  const ny = dx / len;
  const side = rng.bool(0.5) ? 1 : -1;
  const bow = side * rng.range(dist * 0.04, dist * 0.16);
  const c1: Point = {
    x: a.x + dx * 0.3 + nx * bow * rng.range(0.7, 1.0),
    y: a.y + dy * 0.3 + ny * bow * rng.range(0.7, 1.0),
  };
  const c2: Point = {
    x: a.x + dx * 0.68 + nx * bow * rng.range(0.6, 1.0),
    y: a.y + dy * 0.68 + ny * bow * rng.range(0.6, 1.0),
  };

  const out: CursorSample[] = [];
  let tAcc = 0;
  for (let i = 0; i <= steps; i++) {
    const tf = i / steps;
    const point = cubicBezier(a, c1, c2, b, easeParam(tf, skew));
    const envelope = Math.sin(Math.PI * tf);
    if (i > 0) tAcc += (duration / steps) * rng.range(0.7, 1.3);
    out.push({
      x: point.x + rng.gaussian(0, opts.jitterAmp) * envelope,
      y: point.y + rng.gaussian(0, opts.jitterAmp) * envelope,
      t: tAcc,
    });
  }

  out[0] = { x: a.x, y: a.y, t: 0 };
  out[out.length - 1] = { x: b.x, y: b.y, t: tAcc };
  return out;
}

function overshootPoint(from: Point, to: Point, rng: Rng): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(Math.hypot(dx, dy), 1e-4);
  const ux = dx / len;
  const uy = dy / len;
  const over = Math.min(len * 0.12, 110) * rng.range(0.5, 1.1);
  const perp = rng.gaussian(0, 8);
  return { x: to.x + ux * over - uy * perp, y: to.y + uy * over + ux * perp };
}

function monotonic(samples: CursorSample[]): CursorSample[] {
  const out: CursorSample[] = [];
  let lastT = -1;
  for (const s of samples) {
    const t = s.t <= lastT ? lastT + 1 : s.t;
    out.push({ x: s.x, y: s.y, t });
    lastT = t;
  }
  return out;
}

/** A point inside the rect, offset from dead-center (humans miss the middle). */
export function offCenterPoint(rect: Rect, rng: Rng = createRng()): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const ox = clamp(
    rng.gaussian(0, rect.width * 0.18),
    -rect.width * 0.4,
    rect.width * 0.4,
  );
  const oy = clamp(
    rng.gaussian(0, rect.height * 0.18),
    -rect.height * 0.4,
    rect.height * 0.4,
  );
  return { x: cx + ox, y: cy + oy };
}

export function sampleDwellMs(rng: Rng = createRng()): number {
  return Math.round(rng.skewed(60, 300, 2.0));
}

export function samplePressMs(rng: Rng = createRng()): number {
  return Math.round(rng.skewed(45, 130, 1.8));
}

export function sampleKeyDelayMs(rng: Rng = createRng()): {
  min: number;
  max: number;
} {
  const base = rng.range(55, 110);
  return { min: Math.round(base * 0.6), max: Math.round(base * 1.8) };
}
