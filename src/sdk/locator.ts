import type { ActionService } from "../action/service";
import type { LocatorMatch, LocatorSpec, LocatorStep, MouseButton, Rect } from "../protocol";

export interface LocatorContext {
  action: ActionService;
  stealth: boolean;
}

export interface ByOptions {
  exact?: boolean;
}

export interface ByRoleOptions {
  name?: string;
  exact?: boolean;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A lazy, Playwright-shaped handle to an element. Chaining and filtering build
 * up a serializable spec; an action resolves the spec to a rect and then drives
 * the human cursor through ActionService.
 */
export class Locator {
  constructor(
    private readonly ctx: LocatorContext,
    private readonly spec: LocatorSpec,
  ) {}

  locator(css: string): Locator {
    return this.step({ kind: "css", value: css });
  }
  getByRole(role: string, opts: ByRoleOptions = {}): Locator {
    return this.step({ kind: "role", value: role, name: opts.name, exact: opts.exact });
  }
  getByText(text: string, opts: ByOptions = {}): Locator {
    return this.step({ kind: "text", value: text, exact: opts.exact });
  }
  getByLabel(text: string, opts: ByOptions = {}): Locator {
    return this.step({ kind: "label", value: text, exact: opts.exact });
  }
  getByPlaceholder(text: string, opts: ByOptions = {}): Locator {
    return this.step({ kind: "placeholder", value: text, exact: opts.exact });
  }
  getByTestId(id: string): Locator {
    return this.step({ kind: "testid", value: id });
  }
  filter(opts: { hasText: string }): Locator {
    return this.step({ kind: "filter", hasText: opts.hasText });
  }
  nth(index: number): Locator {
    return this.step({ kind: "nth", index });
  }
  first(): Locator {
    return this.nth(0);
  }
  last(): Locator {
    return this.nth(-1);
  }

  async click(opts: { button?: MouseButton; double?: boolean; stealth?: boolean } = {}): Promise<Locator> {
    const m = await this.require();
    await this.ctx.action.click({
      rect: m.rect,
      button: opts.button,
      double: opts.double,
      stealth: opts.stealth ?? this.ctx.stealth,
    });
    return this;
  }
  dblclick(opts: { button?: MouseButton; stealth?: boolean } = {}): Promise<Locator> {
    return this.click({ ...opts, double: true });
  }
  async hover(opts: { stealth?: boolean } = {}): Promise<Locator> {
    const m = await this.require();
    const c = center(m.rect);
    await this.ctx.action.hover({ x: c.x, y: c.y, stealth: opts.stealth ?? this.ctx.stealth });
    return this;
  }
  async type(text: string, opts: { stealth?: boolean } = {}): Promise<Locator> {
    const m = await this.require();
    await this.ctx.action.type({ text, rect: m.rect, stealth: opts.stealth ?? this.ctx.stealth });
    return this;
  }
  async fill(text: string, opts: { stealth?: boolean } = {}): Promise<Locator> {
    const m = await this.require();
    await this.ctx.action.type({ text, rect: m.rect, replace: true, stealth: opts.stealth ?? this.ctx.stealth });
    return this;
  }
  async press(key: string, opts: { stealth?: boolean } = {}): Promise<Locator> {
    const m = await this.require();
    await this.ctx.action.click({ rect: m.rect, stealth: opts.stealth ?? this.ctx.stealth });
    await this.ctx.action.pressKey(key, opts.stealth ?? this.ctx.stealth);
    return this;
  }
  async dragTo(target: Locator, opts: { stealth?: boolean } = {}): Promise<Locator> {
    const from = await this.require();
    const to = await target.require();
    await this.ctx.action.drag({ rect: from.rect }, { rect: to.rect }, "left", opts.stealth ?? this.ctx.stealth);
    return this;
  }
  async scrollIntoView(): Promise<Locator> {
    await this.require();
    return this;
  }

  async boundingBox(): Promise<Rect | null> {
    const m = await this.resolve(false);
    return m.count > 0 ? m.rect : null;
  }
  async textContent(opts: { timeout?: number } = {}): Promise<string | null> {
    const m = await this.resolve(false, opts.timeout);
    return m.count > 0 ? m.text : null;
  }
  async isVisible(): Promise<boolean> {
    const m = await this.resolve(false, 0);
    return m.count > 0 && m.visible;
  }
  async count(): Promise<number> {
    const m = await this.resolve(false, 0);
    return m.count;
  }
  async waitFor(opts: { state?: "visible" | "attached"; timeout?: number } = {}): Promise<Locator> {
    const state = opts.state ?? "visible";
    const deadline = Date.now() + (opts.timeout ?? 10_000);
    for (;;) {
      const m = await this.resolve(false, 0);
      if (m.count > 0 && (state === "attached" || m.visible)) return this;
      if (Date.now() >= deadline) {
        throw new Error(`agentcursor: waitFor(${state}) timed out for locator [${this}]`);
      }
      await delay(150);
    }
  }

  toString(): string {
    return describe(this.spec);
  }

  private step(s: LocatorStep): Locator {
    return new Locator(this.ctx, [...this.spec, s]);
  }
  private resolve(scrollIntoView: boolean, timeoutMs = 5_000): Promise<LocatorMatch> {
    return this.ctx.action.resolveLocator(this.spec, { timeoutMs, scrollIntoView });
  }
  private async require(): Promise<LocatorMatch> {
    const m = await this.resolve(true);
    if (m.count === 0) {
      throw new Error(`agentcursor: no element matched locator [${this}]`);
    }
    return m;
  }
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function describe(spec: LocatorSpec): string {
  return spec
    .map((s) =>
      s.kind === "filter"
        ? `filter(hasText=${s.hasText})`
        : s.kind === "nth"
          ? `nth(${s.index})`
          : s.kind === "role" && s.name
            ? `role=${s.value}[name=${s.name}]`
            : `${s.kind}=${s.value}`,
    )
    .join(" >> ");
}
