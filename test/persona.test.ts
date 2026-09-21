import { describe, expect, it } from "vitest";
import { createPersona, type PersonaTraits } from "../src/persona";

const RANGES: Record<keyof Omit<PersonaTraits, "handedness">, [number, number]> = {
  speedFactor: [0.75, 1.35],
  curviness: [0.6, 1.5],
  jitterPx: [0.7, 2.2],
  overshootProb: [0.25, 0.7],
  overshootMag: [0.08, 0.16],
  precision: [0.1, 0.26],
  dwellScale: [0.7, 1.5],
  pressScale: [0.75, 1.4],
  wpm: [62, 155],
  errorRate: [0, 0.05],
  reactionMs: [180, 520],
  thinkScale: [0.7, 1.5],
  readMsPerChar: [8, 22],
};

describe("Persona", () => {
  it("is fully reproducible from a seed", () => {
    const a = createPersona(12345, { now: () => 0 });
    const b = createPersona(12345, { now: () => 0 });
    expect(b.base).toEqual(a.base);
    // shared seeded stream → identical derived sequences
    const sa = Array.from({ length: 6 }, () => a.thinkTimeMs(200));
    const sb = Array.from({ length: 6 }, () => b.thinkTimeMs(200));
    expect(sb).toEqual(sa);
  });

  it("gives different people for different seeds", () => {
    expect(createPersona(1).base).not.toEqual(createPersona(2).base);
  });

  it("samples every trait inside its human range", () => {
    for (let seed = 0; seed < 60; seed++) {
      const t = createPersona(seed).base;
      for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
        const [lo, hi] = RANGES[key];
        expect(t[key], `${key} @ seed ${seed}`).toBeGreaterThanOrEqual(lo);
        expect(t[key], `${key} @ seed ${seed}`).toBeLessThanOrEqual(hi);
      }
      expect(Math.abs(t.handedness)).toBe(1);
    }
  });

  it("fatigue grows with time, capped, and drifts traits", () => {
    let now = 5_000;
    const p = createPersona(3, { now: () => now });
    expect(p.fatigue).toBe(0);
    now = 5_000 + 10 * 60_000; // 10 min = half of FATIGUE_FULL_MS
    expect(p.fatigue).toBeCloseTo(0.5 * 0.15, 5);
    now = 5_000 + 90 * 60_000; // well past full → capped at FATIGUE_MAX
    expect(p.fatigue).toBeCloseTo(0.15, 5);
    const drifted = p.traits();
    expect(drifted.speedFactor).toBeLessThan(p.base.speedFactor);
    expect(drifted.jitterPx).toBeGreaterThan(p.base.jitterPx);
    expect(drifted.thinkScale).toBeGreaterThan(p.base.thinkScale);
  });

  it("think-time and reading pauses stay in sane bounds", () => {
    const p = createPersona(9, { now: () => 0 });
    for (let i = 0; i < 40; i++) {
      const think = p.thinkTimeMs(600);
      expect(think).toBeGreaterThan(0);
      expect(think).toBeLessThan(3000);
      const read = p.readPauseMs(500);
      expect(read).toBeGreaterThanOrEqual(120);
      expect(read).toBeLessThanOrEqual(4000);
    }
  });

  it("keySchedule types out exactly the requested text", () => {
    const p = createPersona(77);
    for (const s of ["hello world", "The quick brown fox.", "user@example.com"]) {
      const flat = p
        .keySchedule(s)
        .reduce((acc, op) => (op.t === "key" ? acc + op.ch : acc.slice(0, -1)), "");
      expect(flat).toBe(s);
    }
  });
});
