import type { CursorSample, KeyOp, MouseButton, Point } from "../protocol";
import { scheduleToKeystrokes } from "../persona/typing";
import { rand, sleep, sleepUntil } from "../util/timing";

interface NutPoint {
  x: number;
  y: number;
}

export interface NutModule {
  mouse: {
    config: { autoDelayMs: number };
    setPosition(target: NutPoint): Promise<unknown>;
    getPosition(): Promise<NutPoint>;
    pressButton(button: number): Promise<unknown>;
    releaseButton(button: number): Promise<unknown>;
    scrollUp(amount: number): Promise<unknown>;
    scrollDown(amount: number): Promise<unknown>;
    scrollLeft(amount: number): Promise<unknown>;
    scrollRight(amount: number): Promise<unknown>;
  };
  keyboard: {
    config: { autoDelayMs: number };
    type(input: string): Promise<unknown>;
    pressKey(...keys: number[]): Promise<unknown>;
    releaseKey(...keys: number[]): Promise<unknown>;
  };
  Button: { LEFT: number; MIDDLE: number; RIGHT: number };
  Key: Record<string, number>;
  Point: new (x: number, y: number) => NutPoint;
}

let loaded: Promise<NutModule> | null = null;

export function loadNut(): Promise<NutModule> {
  loaded ??= (async () => {
    // Variable specifier keeps this an optional runtime dep, not a build dep.
    const spec = "@nut-tree-fork/nut-js";
    try {
      const nut = (await import(spec)) as unknown as NutModule;
      nut.mouse.config.autoDelayMs = 0;
      nut.keyboard.config.autoDelayMs = 0;
      return nut;
    } catch {
      loaded = null;
      throw new Error(
        "OS cursor control needs @nut-tree-fork/nut-js. Install it with: pnpm add @nut-tree-fork/nut-js",
      );
    }
  })();
  return loaded;
}

export function nutButton(nut: NutModule, button: MouseButton): number {
  if (button === "right") return nut.Button.RIGHT;
  if (button === "middle") return nut.Button.MIDDLE;
  return nut.Button.LEFT;
}

export async function playPath(
  nut: NutModule,
  samples: CursorSample[],
  toScreen: (p: Point) => Point = (p) => p,
): Promise<void> {
  const start = performance.now();
  for (const s of samples) {
    await sleepUntil(start + s.t);
    const p = toScreen(s);
    await nut.mouse.setPosition(new nut.Point(p.x, p.y));
  }
}

export async function pressButton(
  nut: NutModule,
  button: MouseButton,
  pressMs: number,
  double = false,
): Promise<void> {
  const b = nutButton(nut, button);
  for (let i = 0; i < (double ? 2 : 1); i++) {
    if (i) await sleep(40);
    await nut.mouse.pressButton(b);
    await sleep(pressMs);
    await nut.mouse.releaseButton(b);
  }
}

// nut-js types literal characters (no live backspace), so a persona schedule
// renders its surviving keystrokes with their delays, without typo corrections.
export async function typeText(
  nut: NutModule,
  text: string,
  opts: { schedule?: KeyOp[]; perKeyMinMs: number; perKeyMaxMs: number },
): Promise<void> {
  if (opts.schedule?.length) {
    for (const k of scheduleToKeystrokes(opts.schedule)) {
      await nut.keyboard.type(k.ch);
      await sleep(Math.max(0, k.delayMs));
    }
    return;
  }
  for (const ch of text) {
    await nut.keyboard.type(ch);
    await sleep(rand(opts.perKeyMinMs, opts.perKeyMaxMs));
  }
}

export async function scrollSteps(nut: NutModule, dx: number, dy: number, steps: number): Promise<void> {
  const n = Math.max(1, steps);
  for (let i = 0; i < n; i++) {
    const v = dy ? Math.max(1, Math.round(Math.abs(dy / n))) : 0;
    const h = dx ? Math.max(1, Math.round(Math.abs(dx / n))) : 0;
    if (v) await (dy >= 0 ? nut.mouse.scrollDown(v) : nut.mouse.scrollUp(v));
    if (h) await (dx >= 0 ? nut.mouse.scrollRight(h) : nut.mouse.scrollLeft(h));
    await sleep(rand(12, 28));
  }
}

const KEY_ALIASES: Record<string, string> = {
  cmd: "LeftCmd", command: "LeftCmd", meta: "LeftCmd", super: "LeftSuper", win: "LeftWin",
  ctrl: "LeftControl", control: "LeftControl", alt: "LeftAlt", option: "LeftAlt", opt: "LeftAlt",
  shift: "LeftShift", enter: "Enter", return: "Return", esc: "Escape", escape: "Escape",
  tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", del: "Delete",
  up: "Up", down: "Down", left: "Left", right: "Right", arrowup: "Up", arrowdown: "Down",
  arrowleft: "Left", arrowright: "Right", home: "Home", end: "End", pageup: "PageUp",
  pagedown: "PageDown", "-": "Minus", "=": "Equal", ",": "Comma", ".": "Period", "/": "Slash",
  ";": "Semicolon", "'": "Quote", "[": "LeftBracket", "]": "RightBracket", "\\": "Backslash", "`": "Grave",
};

export function parseKeyCombo(combo: string): string[] {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Empty key combo");
  return parts.map((part) => {
    const lower = part.toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]!;
    if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
    if (/^[0-9]$/.test(lower)) return `Num${lower}`;
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
    throw new Error(`Unknown key "${part}" in "${combo}"`);
  });
}

export async function pressCombo(nut: NutModule, combo: string, holdMs: number): Promise<void> {
  const keys = parseKeyCombo(combo).map((name) => nut.Key[name]!);
  await nut.keyboard.pressKey(...keys);
  await sleep(holdMs);
  await nut.keyboard.releaseKey(...keys.reverse());
}
