import type { MouseButton, PageElement, PageSnapshot, Point } from "../protocol";
import type { BrowserDriver } from "../drivers/driver";
import {
  createRng,
  generateMove,
  offCenterPoint,
  sampleDwellMs,
  sampleKeyDelayMs,
  samplePressMs,
} from "../path-engine";

interface TargetOpts {
  ref?: string;
  x?: number;
  y?: number;
}

interface ResolvedTarget {
  point: Point;
  width: number;
}

/**
 * High-level human actions. Owns the cached snapshot + last cursor position,
 * turns a target into a human path via the engine, and hands samples to the
 * driver. Knows nothing about the transport (depends on BrowserDriver).
 */
export class ActionService {
  private snapshot: PageSnapshot | null = null;
  private lastPos: Point | null = null;

  constructor(private readonly driver: BrowserDriver) {}

  async readPage(maxElements = 60, includeText = true): Promise<PageSnapshot> {
    this.snapshot = await this.driver.snapshot(maxElements, includeText);
    return this.snapshot;
  }

  async moveTo(opts: TargetOpts & { stealth?: boolean }): Promise<Point> {
    await this.ensureFresh(opts.ref);
    const from = await this.ensureStart();
    const { point, width } = await this.resolveTarget(opts);
    const samples = generateMove(from, point, { targetWidth: width });
    await this.driver.move(samples, mode(opts.stealth));
    this.lastPos = point;
    return point;
  }

  async click(
    opts: TargetOpts & {
      button?: MouseButton;
      double?: boolean;
      stealth?: boolean;
    },
  ): Promise<Point> {
    await this.ensureFresh(opts.ref);
    const from = await this.ensureStart();
    const { point, width } = await this.resolveTarget(opts);
    const rng = createRng();
    const samples = generateMove(from, point, { targetWidth: width, rng });
    await this.driver.click({
      samples,
      target: point,
      button: opts.button ?? "left",
      dblclick: opts.double ?? false,
      preClickDwellMs: sampleDwellMs(rng),
      pressMs: samplePressMs(rng),
      mode: mode(opts.stealth),
    });
    this.lastPos = point;
    return point;
  }

  async type(opts: {
    text: string;
    ref?: string;
    stealth?: boolean;
  }): Promise<void> {
    if (opts.ref) await this.click({ ref: opts.ref, stealth: opts.stealth });
    const delay = sampleKeyDelayMs(createRng());
    await this.driver.type({
      text: opts.text,
      ref: opts.ref,
      perKeyMinMs: delay.min,
      perKeyMaxMs: delay.max,
      mode: mode(opts.stealth),
    });
  }

  async scroll(opts: {
    dy: number;
    dx?: number;
    stealth?: boolean;
  }): Promise<void> {
    const rng = createRng();
    const steps = Math.max(3, Math.round(Math.abs(opts.dy) / rng.range(80, 140)));
    await this.driver.scroll({
      dx: opts.dx ?? 0,
      dy: opts.dy,
      steps,
      mode: mode(opts.stealth),
    });
  }

  async navigate(url: string): Promise<void> {
    this.snapshot = null;
    this.lastPos = null;
    await this.driver.navigate(url);
  }

  getUrl(): Promise<string> {
    return this.driver.getUrl();
  }

  waitFor(opts: {
    ref?: string;
    text?: string;
    timeoutMs?: number;
    condition?: "exists" | "visible" | "text";
  }): Promise<boolean> {
    return this.driver.waitFor({
      ref: opts.ref,
      text: opts.text,
      timeoutMs: opts.timeoutMs ?? 10_000,
      condition: opts.condition,
    });
  }

  async screenshot(format: "png" | "jpeg" = "png"): Promise<string> {
    return this.driver.screenshot(format);
  }

  async hover(opts: { ref?: string; x?: number; y?: number; stealth?: boolean } = {}): Promise<void> {
    // For hover we do a human-like approach move first (visible cursor), then hover events.
    // This makes hover part of natural workflows and testing (tooltips, menus, etc.).
    if (opts.ref || (typeof opts.x === "number" && typeof opts.y === "number")) {
      await this.moveTo({ ref: opts.ref, x: opts.x, y: opts.y, stealth: opts.stealth });
    }
    await this.driver.hover(opts);
  }

  async drag(from: TargetOpts, to: TargetOpts, button: MouseButton = "left", stealth?: boolean): Promise<void> {
    const need = !!(from.ref || to.ref);
    if (from.ref) await this.driver.ensureVisible(from.ref);
    if (to.ref) await this.driver.ensureVisible(to.ref);
    if (need) await this.readPage();
    const start = await this.resolveTarget(from);
    const end = await this.resolveTarget(to);
    const rng = createRng();
    const samples = generateMove(start.point, end.point, { targetWidth: end.width, rng });
    await this.driver.drag({
      samples,
      target: end.point,
      button,
      mode: mode(stealth),
    });
  }

  private async ensureStart(): Promise<Point> {
    if (this.lastPos) return this.lastPos;
    this.lastPos = await this.driver.cursorState();
    return this.lastPos;
  }

  private async ensureFresh(ref?: string): Promise<void> {
    if (ref) {
      await this.driver.ensureVisible(ref);
      await this.readPage();
    }
  }

  private async resolveTarget(opts: TargetOpts): Promise<ResolvedTarget> {
    if (typeof opts.x === "number" && typeof opts.y === "number") {
      return { point: { x: opts.x, y: opts.y }, width: 24 };
    }
    if (!opts.ref) {
      throw new Error("Provide either a `ref` or explicit `x`/`y` coordinates.");
    }
    const el = await this.findElement(opts.ref);
    const width = Math.max(Math.min(el.rect.width, el.rect.height), 8);
    return { point: offCenterPoint(el.rect, createRng()), width };
  }

  private async findElement(ref: string): Promise<PageElement> {
    let el = this.snapshot?.elements.find((e) => e.ref === ref);
    if (!el) {
      await this.readPage();  // auto-refresh on miss (DRY resilience for SPAs)
      el = this.snapshot?.elements.find((e) => e.ref === ref);
    }
    if (!el) {
      // one more aggressive refresh
      await this.readPage();
      el = this.snapshot?.elements.find((e) => e.ref === ref);
    }
    if (!el) {
      throw new Error(
        `Element '${ref}' not found. Call read_page to refresh element refs.`,
      );
    }
    return el;
  }
}

function mode(stealth?: boolean): "content" | "debugger" {
  return stealth ? "debugger" : "content";
}
