import type {
  CursorSample,
  DeliveryMode,
  MouseButton,
  PageSnapshot,
  Point,
  Rect,
  WindowGeometry,
} from "../protocol";
import type { ExtensionTransport } from "../server/transport";
import { rand, sleep, sleepUntil } from "../util/timing";
import { screenToViewport, viewportToScreen } from "./coord-map";
import type {
  BrowserDriver,
  ClickArgs,
  ScrollArgs,
  TypeArgs,
  WaitArgs,
} from "./driver";

interface NutPoint {
  x: number;
  y: number;
}

interface NutModule {
  mouse: {
    config: { autoDelayMs: number };
    setPosition(target: NutPoint): Promise<unknown>;
    getPosition(): Promise<NutPoint>;
    pressButton(button: number): Promise<unknown>;
    releaseButton(button: number): Promise<unknown>;
    scrollUp(amount: number): Promise<unknown>;
    scrollDown(amount: number): Promise<unknown>;
  };
  keyboard: { config: { autoDelayMs: number }; type(input: string): Promise<unknown> };
  Button: { LEFT: number; MIDDLE: number; RIGHT: number };
  Point: new (x: number, y: number) => NutPoint;
}

async function loadNut(): Promise<NutModule> {
  // Variable specifier keeps this an optional runtime dep, not a build dep.
  const spec = "@nut-tree-fork/nut-js";
  try {
    return (await import(spec)) as unknown as NutModule;
  } catch {
    throw new Error(
      "The OS-cursor driver needs @nut-tree-fork/nut-js. Install it with: pnpm add @nut-tree-fork/nut-js",
    );
  }
}

/**
 * Phase 2: moves the real macOS system cursor (genuine OS events, isTrusted
 * and indistinguishable). Senses the page through the extension; acts through
 * nut-js. Implements the same BrowserDriver interface as the extension driver.
 */
export class OsCursorDriver implements BrowserDriver {
  private nut: NutModule | null = null;
  private geom: WindowGeometry | null = null;

  constructor(private readonly transport: ExtensionTransport) {}

  async snapshot(maxElements: number, includeText: boolean): Promise<PageSnapshot> {
    return (await this.transport.send({
      kind: "snapshot",
      maxElements,
      includeText,
    })) as PageSnapshot;
  }

  async getUrl(): Promise<string> {
    return (await this.transport.send({ kind: "getUrl" })) as string;
  }

  async navigate(url: string): Promise<void> {
    this.geom = null;
    await this.transport.send({ kind: "navigate", url });
  }

  async waitFor(args: WaitArgs): Promise<boolean> {
    return (await this.transport.send(
      { kind: "waitFor", ...args },
      args.timeoutMs + 5_000,
    )) as boolean;
  }

  async screenshot(format: "png" | "jpeg" = "png"): Promise<string> {
    return (await this.transport.send({ kind: "screenshot", format })) as string;
  }

  async hover(opts: { ref?: string; x?: number; y?: number; stealth?: boolean }): Promise<void> {
    // Hover events come from the extension bridge; OS cursor already moved during approach if needed
    await this.transport.send(
      { kind: "hover", ref: opts.ref, x: opts.x, y: opts.y, mode: "content" },
      30_000,
    );
  }

  async ensureVisible(ref?: string, point?: Point): Promise<Rect | null> {
    return (await this.transport.send({
      kind: "ensureVisible",
      ref,
      point,
    })) as Rect | null;
  }

  async drag(args: { samples: CursorSample[]; target: Point; button: MouseButton; mode: DeliveryMode }): Promise<void> {
    // Real drag: position at the start, hold the button, move the path, release.
    const nut = await this.ensureNut();
    const g = await this.geometry();
    const first = args.samples[0];
    if (!first) return;
    const button = nutButton(nut, args.button);
    const startScreen = viewportToScreen(first, g);
    await nut.mouse.setPosition(new nut.Point(startScreen.x, startScreen.y));
    await nut.mouse.pressButton(button);
    await sleep(rand(40, 90));
    await this.move(args.samples, args.mode);
    await sleep(rand(40, 90));
    await nut.mouse.releaseButton(button);
  }

  async cursorState(): Promise<Point> {
    const nut = await this.ensureNut();
    const pos = await nut.mouse.getPosition();
    return screenToViewport(pos, await this.geometry());
  }

  async move(samples: CursorSample[], _mode: DeliveryMode): Promise<void> {
    const nut = await this.ensureNut();
    const g = await this.geometry();
    const start = performance.now();
    for (const s of samples) {
      await sleepUntil(start + s.t);
      const screen = viewportToScreen(s, g);
      await nut.mouse.setPosition(new nut.Point(screen.x, screen.y));
    }
  }

  async click(args: ClickArgs): Promise<void> {
    const nut = await this.ensureNut();
    await this.move(args.samples, args.mode);
    await sleep(args.preClickDwellMs);
    const button = nutButton(nut, args.button);
    await nut.mouse.pressButton(button);
    await sleep(args.pressMs);
    await nut.mouse.releaseButton(button);
    if (args.dblclick) {
      await sleep(40);
      await nut.mouse.pressButton(button);
      await sleep(args.pressMs);
      await nut.mouse.releaseButton(button);
    }
  }

  async type(args: TypeArgs): Promise<void> {
    const nut = await this.ensureNut();
    nut.keyboard.config.autoDelayMs = 0;
    for (const ch of args.text) {
      await nut.keyboard.type(ch);
      await sleep(rand(args.perKeyMinMs, args.perKeyMaxMs));
    }
  }

  async scroll(args: ScrollArgs): Promise<void> {
    const nut = await this.ensureNut();
    const steps = Math.max(1, args.steps);
    const perStep = args.dy / steps;
    for (let i = 0; i < steps; i++) {
      const amount = Math.max(1, Math.round(Math.abs(perStep)));
      if (perStep >= 0) await nut.mouse.scrollDown(amount);
      else await nut.mouse.scrollUp(amount);
      await sleep(rand(12, 28));
    }
  }

  private async ensureNut(): Promise<NutModule> {
    if (!this.nut) {
      this.nut = await loadNut();
      this.nut.mouse.config.autoDelayMs = 0;
    }
    return this.nut;
  }

  private async geometry(): Promise<WindowGeometry> {
    if (!this.geom) {
      this.geom = (await this.transport.send({
        kind: "windowGeometry",
      })) as WindowGeometry;
    }
    return this.geom;
  }
}

function nutButton(nut: NutModule, button: "left" | "right" | "middle"): number {
  if (button === "right") return nut.Button.RIGHT;
  if (button === "middle") return nut.Button.MIDDLE;
  return nut.Button.LEFT;
}
