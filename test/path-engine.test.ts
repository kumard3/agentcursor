import { describe, expect, it } from "vitest";
import type { CursorSample, Point } from "../src/protocol";
import {
  createRng,
  generateMove,
  offCenterPoint,
  sampleDwellMs,
} from "../src/path-engine";
import { distance } from "../src/path-engine/geometry";

const A: Point = { x: 100, y: 100 };
const B: Point = { x: 700, y: 420 };

function pathLength(p: CursorSample[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += distance(p[i - 1]!, p[i]!);
  return s;
}

function straightness(p: CursorSample[]): number {
  return distance(p[0]!, p.at(-1)!) / pathLength(p);
}

function maxPerpDeviation(p: CursorSample[], a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let max = 0;
  for (const pt of p) {
    const d = Math.abs((pt.x - a.x) * dy - (pt.y - a.y) * dx) / len;
    if (d > max) max = d;
  }
  return max;
}

function stepSpeeds(p: CursorSample[]): number[] {
  const v: number[] = [];
  for (let i = 1; i < p.length; i++) {
    const dt = p[i]!.t - p[i - 1]!.t;
    v.push(distance(p[i - 1]!, p[i]!) / Math.max(dt, 1));
  }
  return v;
}

function variance(a: number[]): number {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length;
}

function avgFinalT(a: Point, b: Point): number {
  let s = 0;
  const n = 8;
  for (let i = 0; i < n; i++) {
    s += generateMove(a, b, { rng: createRng(100 + i) }).at(-1)!.t;
  }
  return s / n;
}

describe("generateMove", () => {
  it("starts at `from` and ends at `to`", () => {
    const p = generateMove(A, B, { rng: createRng(1) });
    expect(p[0]!.x).toBeCloseTo(A.x, 5);
    expect(p[0]!.y).toBeCloseTo(A.y, 5);
    expect(p.at(-1)!.x).toBeCloseTo(B.x, 5);
    expect(p.at(-1)!.y).toBeCloseTo(B.y, 5);
  });

  it("has strictly increasing timestamps starting at 0", () => {
    const p = generateMove(A, B, { rng: createRng(2) });
    expect(p[0]!.t).toBe(0);
    for (let i = 1; i < p.length; i++) {
      expect(p[i]!.t).toBeGreaterThan(p[i - 1]!.t);
    }
  });

  it("produces enough samples for a long move", () => {
    expect(generateMove(A, B, { rng: createRng(3) }).length).toBeGreaterThan(8);
  });

  it("is not a straight line", () => {
    const p = generateMove(A, B, { rng: createRng(4), overshoot: false });
    expect(maxPerpDeviation(p, A, B)).toBeGreaterThan(1);
    expect(straightness(p)).toBeLessThan(0.999);
  });

  it("has non-constant velocity", () => {
    expect(variance(stepSpeeds(generateMove(A, B, { rng: createRng(5) })))).toBeGreaterThan(0);
  });

  it("is deterministic for a fixed seed", () => {
    expect(generateMove(A, B, { rng: createRng(42) })).toEqual(
      generateMove(A, B, { rng: createRng(42) }),
    );
  });

  it("never replays the same path without a seed", () => {
    expect(generateMove(A, B)).not.toEqual(generateMove(A, B));
  });

  it("scales duration with distance (Fitts's law)", () => {
    const near = avgFinalT({ x: 0, y: 0 }, { x: 60, y: 0 });
    const far = avgFinalT({ x: 0, y: 0 }, { x: 1200, y: 0 });
    expect(far).toBeGreaterThan(near);
  });

  it("overshoots past the target on long moves for some seeds", () => {
    const chord = distance(A, B);
    let overshot = false;
    for (let s = 0; s < 40 && !overshot; s++) {
      const p = generateMove(A, B, { rng: createRng(s) });
      overshot = p.some((pt) => distance(A, pt) > chord + 5);
    }
    expect(overshot).toBe(true);
  });

  it("handles a zero-length move without throwing", () => {
    expect(() => generateMove(A, A, { rng: createRng(8) })).not.toThrow();
  });
});

describe("offCenterPoint", () => {
  it("lands inside the rect but rarely dead-center", () => {
    const rect = { x: 0, y: 0, width: 120, height: 40 };
    const rng = createRng(7);
    let exactCenter = 0;
    for (let i = 0; i < 200; i++) {
      const pt = offCenterPoint(rect, rng);
      expect(pt.x).toBeGreaterThanOrEqual(0);
      expect(pt.x).toBeLessThanOrEqual(120);
      expect(pt.y).toBeGreaterThanOrEqual(0);
      expect(pt.y).toBeLessThanOrEqual(40);
      if (pt.x === 60 && pt.y === 20) exactCenter++;
    }
    expect(exactCenter).toBeLessThan(5);
  });
});

describe("sampleDwellMs", () => {
  it("stays in range and varies", () => {
    const rng = createRng(9);
    const vals = Array.from({ length: 50 }, () => sampleDwellMs(rng));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(60);
      expect(v).toBeLessThanOrEqual(300);
    }
    expect(new Set(vals).size).toBeGreaterThan(5);
  });
});
