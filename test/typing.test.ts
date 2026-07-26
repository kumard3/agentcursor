import { describe, expect, it } from "vitest";
import { createRng } from "../src/path-engine";
import {
  buildTypingSchedule,
  flattenSchedule,
  scheduleToKeystrokes,
} from "../src/persona/typing";

const SAMPLES = [
  "hello world",
  "The quick brown fox jumps. Then it stops!",
  "agentcursor makes automation feel human",
];

describe("buildTypingSchedule", () => {
  it("always renders exactly the input text, even with typos", () => {
    for (let seed = 0; seed < 40; seed++) {
      const ops = buildTypingSchedule(SAMPLES[seed % SAMPLES.length]!, createRng(seed), {
        wpm: 300,
        errorRate: 0.15,
        reactionMs: 300,
      });
      expect(flattenSchedule(ops)).toBe(SAMPLES[seed % SAMPLES.length]);
    }
  });

  it("emits no backspaces when errorRate is 0", () => {
    const ops = buildTypingSchedule("no mistakes here", createRng(1), {
      wpm: 250,
      errorRate: 0,
      reactionMs: 250,
    });
    expect(ops.every((o) => o.t === "key")).toBe(true);
    expect(ops.length).toBe("no mistakes here".length);
  });

  it("produces at least one typo correction across seeds when errorRate is high", () => {
    let sawTypo = false;
    for (let seed = 0; seed < 30 && !sawTypo; seed++) {
      const ops = buildTypingSchedule("the quick brown fox", createRng(seed), {
        wpm: 300,
        errorRate: 0.4,
        reactionMs: 300,
      });
      sawTypo = ops.some((o) => o.t === "back");
    }
    expect(sawTypo).toBe(true);
  });

  it("makes the first keystroke slow (reaction time)", () => {
    const ops = buildTypingSchedule("abc", createRng(5), {
      wpm: 300,
      errorRate: 0,
      reactionMs: 400,
    });
    expect(ops[0]!.delayMs).toBeGreaterThan(400 * 0.5);
  });

  it("scheduleToKeystrokes reduces to the final text", () => {
    const ops = buildTypingSchedule("correct me", createRng(11), {
      wpm: 300,
      errorRate: 0.3,
      reactionMs: 300,
    });
    expect(scheduleToKeystrokes(ops).map((k) => k.ch).join("")).toBe("correct me");
  });

  it("all delays are non-negative integers", () => {
    const ops = buildTypingSchedule(SAMPLES[1]!, createRng(2), {
      wpm: 220,
      errorRate: 0.1,
      reactionMs: 300,
    });
    for (const op of ops) {
      expect(Number.isInteger(op.delayMs)).toBe(true);
      expect(op.delayMs).toBeGreaterThanOrEqual(0);
    }
  });
});
