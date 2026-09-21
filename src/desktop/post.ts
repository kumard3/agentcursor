import type { CursorSample, KeyOp, MouseButton, Point } from "../protocol";
import { ax } from "./ax";

/** Events posted straight to one process: the user's pointer and focus stay untouched. */
export interface PostPlan {
  moves?: CursorSample[];
  click?: { x: number; y: number; button?: MouseButton; double?: boolean; dwellMs?: number; pressMs?: number };
  scroll?: { dx: number; dy: number; steps: number };
  keys?: Array<{ ch?: string; code?: number; flags?: number; delayMs: number }>;
  button?: MouseButton;
}

export function post(pid: number | undefined, plan: PostPlan): Promise<{ x: number; y: number }> {
  const args = pid === undefined ? ["post"] : ["post", "--pid", String(pid)];
  return ax<{ x: number; y: number }>(args, 120_000, JSON.stringify(plan));
}

const FLAGS = { cmd: 1 << 20, shift: 1 << 17, alt: 1 << 19, ctrl: 1 << 18, fn: 1 << 23 } as const;

// Virtual key codes (ANSI layout); only the ones a shortcut normally needs.
const CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
};

/** "cmd+shift+t" to a posted key event. */
export function combo(keys: string): { code: number; flags: number; delayMs: number } {
  let flags = 0;
  let code: number | undefined;
  for (const raw of keys.toLowerCase().split("+")) {
    const part = raw.trim();
    if (part === "cmd" || part === "command" || part === "meta") flags |= FLAGS.cmd;
    else if (part === "shift") flags |= FLAGS.shift;
    else if (part === "alt" || part === "option") flags |= FLAGS.alt;
    else if (part === "ctrl" || part === "control") flags |= FLAGS.ctrl;
    else code = CODES[part];
  }
  if (code === undefined) throw new Error(`agentcursor: no key code for '${keys}'`);
  return { code, flags, delayMs: 0 };
}

/** A persona typing schedule as posted key events, typos and corrections included. */
export function keyOps(schedule: KeyOp[]): PostPlan["keys"] {
  return schedule.map((op) =>
    op.t === "back" ? { code: CODES.backspace!, delayMs: op.delayMs } : { ch: op.ch, delayMs: op.delayMs },
  );
}

export const origin: Point = { x: 0, y: 0 };
