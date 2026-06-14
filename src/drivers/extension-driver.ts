import type {
  CursorSample,
  DeliveryMode,
  PageSnapshot,
  Point,
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
}
