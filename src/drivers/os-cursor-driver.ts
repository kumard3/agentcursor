import type {
  CursorSample,
  DeliveryMode,
  LocatorMatch,
  LocatorSpec,
  MouseButton,
  PageSnapshot,
  Point,
  Rect,
  WindowGeometry,
} from "../protocol";
import type { ExtensionTransport } from "../server/transport";
import { rand, sleep } from "../util/timing";
import { screenToViewport, viewportToScreen } from "./coord-map";
import { loadNut, nutButton, playPath, pressButton, scrollSteps, typeText } from "./nut";
import type {
  BrowserDriver,
  ClickArgs,
  ScrollArgs,
  TypeArgs,
  WaitArgs,
} from "./driver";

/**
 * Phase 2: moves the real macOS system cursor (genuine OS events, isTrusted
 * and indistinguishable). Senses the page through the extension; acts through
 * nut-js. Implements the same BrowserDriver interface as the extension driver.
 */
export class OsCursorDriver implements BrowserDriver {
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
    const nut = await loadNut();
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

  async pressKey(key: string, mode: DeliveryMode): Promise<void> {
    // Keys go through the extension bridge (content or debugger), same as hover.
    await this.transport.send({ kind: "pressKey", key, mode });
  }

  // Locator resolution is DOM-side, so it goes through the extension bridge even
  // in OS mode (only the cursor itself is driven by nut-js).
  async resolveLocator(
    spec: LocatorSpec,
    opts: { timeoutMs: number; scrollIntoView?: boolean },
  ): Promise<LocatorMatch> {
    return (await this.transport.send(
      { kind: "resolveLocator", spec, timeoutMs: opts.timeoutMs, scrollIntoView: opts.scrollIntoView },
      opts.timeoutMs + 5_000,
    )) as LocatorMatch;
  }

  async cursorState(): Promise<Point> {
    const nut = await loadNut();
    const pos = await nut.mouse.getPosition();
    return screenToViewport(pos, await this.geometry());
  }

  async move(samples: CursorSample[], _mode: DeliveryMode): Promise<void> {
    const g = await this.geometry();
    await playPath(await loadNut(), samples, (p) => viewportToScreen(p, g));
  }

  async click(args: ClickArgs): Promise<void> {
    await this.move(args.samples, args.mode);
    await sleep(args.preClickDwellMs);
    await pressButton(await loadNut(), args.button, args.pressMs, args.dblclick);
  }

  async type(args: TypeArgs): Promise<void> {
    await typeText(await loadNut(), args.text, args);
  }

  async scroll(args: ScrollArgs): Promise<void> {
    await scrollSteps(await loadNut(), 0, args.dy, args.steps);
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
