import type { AgentCursor } from "./agent-cursor";
import { Locator } from "./locator";

export interface Expectation {
  readonly not: Expectation;
  toBeVisible(): Promise<void>;
  toBeHidden(): Promise<void>;
  toHaveText(expected: string | RegExp): Promise<void>;
  toContainText(expected: string): Promise<void>;
  toHaveCount(expected: number): Promise<void>;
  toHaveURL(expected: string | RegExp): Promise<void>;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Playwright-style web-first assertions: each matcher re-checks the live page
 * until it passes or `timeout` (default 5s) runs out, so tests don't need sleeps.
 */
export function expect(target: Locator | AgentCursor, opts: { timeout?: number } = {}): Expectation {
  return build(target, opts.timeout ?? 5_000, false);
}

function build(target: Locator | AgentCursor, timeout: number, negate: boolean): Expectation {
  const loc = (): Locator => {
    if (target instanceof Locator) return target;
    throw new Error("agentcursor: this matcher needs a locator, e.g. expect(ac.getByText('Saved'))");
  };
  const assert = async (name: string, expected: unknown, check: () => Promise<[boolean, unknown]>) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const [pass, actual] = await check();
      if (pass !== negate) return;
      if (Date.now() >= deadline) {
        const subject = target instanceof Locator ? `locator [${target}]` : "page";
        const want = expected === undefined ? "" : String(expected);
        throw new Error(
          `expect(${subject}).${negate ? "not." : ""}${name}(${want}) failed after ${timeout}ms, got ${JSON.stringify(actual)}`,
        );
      }
      await delay(100);
    }
  };
  const text = () => loc().textContent({ timeout: 0 });
  const visible = async (): Promise<[boolean, unknown]> => {
    const v = await loc().isVisible();
    return [v, v ? "visible" : "hidden"];
  };

  return {
    get not() {
      return build(target, timeout, !negate);
    },
    toBeVisible: () => assert("toBeVisible", undefined, visible),
    toBeHidden: () => assert("toBeHidden", undefined, async () => {
      const [v, actual] = await visible();
      return [!v, actual];
    }),
    toHaveText: (expected) =>
      assert("toHaveText", expected, async () => {
        const t = await text();
        const pass = t !== null && (typeof expected === "string" ? norm(t) === norm(expected) : expected.test(t));
        return [pass, t];
      }),
    toContainText: (expected) =>
      assert("toContainText", expected, async () => {
        const t = await text();
        return [t !== null && norm(t).includes(norm(expected)), t];
      }),
    toHaveCount: (expected) =>
      assert("toHaveCount", expected, async () => {
        const n = await loc().count();
        return [n === expected, n];
      }),
    toHaveURL: (expected) =>
      assert("toHaveURL", expected, async () => {
        if (target instanceof Locator) throw new Error("agentcursor: toHaveURL needs the page, e.g. expect(ac)");
        const url = await target.url();
        return [typeof expected === "string" ? url === expected : expected.test(url), url];
      }),
  };
}
