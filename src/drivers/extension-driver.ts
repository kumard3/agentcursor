import type {
  CursorSample,
  DeliveryMode,
  MouseButton,
  PageSnapshot,
  Point,
  Rect,
} from "../protocol";
import type { ExtensionTransport } from "../server/transport";
import type {
  BrowserDriver,
  ClickArgs,
  ScrollArgs,
  TypeArgs,
  WaitArgs,
} from "./driver";

const ACTION_TIMEOUT_MS = 60_000;

export class ExtensionDriver implements BrowserDriver {
  constructor(private readonly transport: ExtensionTransport) {}

  async snapshot(
    maxElements: number,
    includeText: boolean,
  ): Promise<PageSnapshot> {
    return (await this.transport.send({
      kind: "snapshot",
      maxElements,
      includeText,
    })) as PageSnapshot;
  }

  async cursorState(): Promise<Point> {
    return (await this.transport.send({ kind: "cursorState" })) as Point;
  }

  async move(samples: CursorSample[], mode: DeliveryMode): Promise<void> {
    await this.transport.send(
      { kind: "replayMove", samples, mode },
      ACTION_TIMEOUT_MS,
    );
  }

  async click(args: ClickArgs): Promise<void> {
    await this.transport.send(
      { kind: "replayClick", ...args },
      ACTION_TIMEOUT_MS,
    );
  }

  async type(args: TypeArgs): Promise<void> {
    await this.transport.send({ kind: "type", ...args }, ACTION_TIMEOUT_MS);
  }

  async scroll(args: ScrollArgs): Promise<void> {
    await this.transport.send({ kind: "scroll", ...args }, ACTION_TIMEOUT_MS);
  }

  async navigate(url: string): Promise<void> {
    await this.transport.send({ kind: "navigate", url });
  }

  async getUrl(): Promise<string> {
    return (await this.transport.send({ kind: "getUrl" })) as string;
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
    const mode = opts.stealth ? "debugger" : "content";
    await this.transport.send(
      { kind: "hover", ref: opts.ref, x: opts.x, y: opts.y, mode },
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
    await this.transport.send({ kind: "drag", ...args }, 60_000);
  }
}
