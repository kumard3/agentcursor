import { writeFile } from "node:fs/promises";
import { ActionService } from "../action/service";
import { ExtensionDriver } from "../drivers/extension-driver";
import { OsCursorDriver } from "../drivers/os-cursor-driver";
import { DEFAULT_WS_PORT } from "../protocol";
import { ExtensionTransport } from "../server/transport";
import { Locator } from "./locator";
import type { ByOptions, ByRoleOptions, LocatorContext } from "./locator";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ConnectOptions {
  /** WebSocket port the extension connects to (default 8930). */
  port?: number;
  /** Deliver events via CDP (isTrusted=true) instead of synthetic DOM events. */
  stealth?: boolean;
  /** How long to wait for the browser/extension to connect (default 15s). */
  timeoutMs?: number;
}

/**
 * Programmatic entry point. Playwright-shaped locator API where every action is
 * driven by the human-cursor engine. Lifecycles: connect() attaches to a running
 * Chrome with the extension loaded; os() drives the real OS cursor via nut-js.
 */
export class AgentCursor {
  private constructor(
    private readonly action: ActionService,
    private readonly transport: ExtensionTransport,
    private readonly opts: { stealth: boolean },
  ) {}

  static connect(options: ConnectOptions = {}): Promise<AgentCursor> {
    return AgentCursor.start(options, (t) => new ExtensionDriver(t));
  }

  static os(options: ConnectOptions = {}): Promise<AgentCursor> {
    return AgentCursor.start(options, (t) => new OsCursorDriver(t));
  }

  private static async start(
    options: ConnectOptions,
    makeDriver: (t: ExtensionTransport) => ExtensionDriver | OsCursorDriver,
  ): Promise<AgentCursor> {
    const port = options.port ?? DEFAULT_WS_PORT;
    const transport = new ExtensionTransport(port);
    await waitForConnection(transport, port, options.timeoutMs ?? 15_000);
    const action = new ActionService(makeDriver(transport));
    return new AgentCursor(action, transport, { stealth: options.stealth ?? false });
  }

  /** Escape hatch to the lower-level action service (move_to by coords, find, clickText, etc.). */
  get actions(): ActionService {
    return this.action;
  }

  locator(css: string): Locator {
    return this.root().locator(css);
  }
  getByRole(role: string, opts?: ByRoleOptions): Locator {
    return this.root().getByRole(role, opts);
  }
  getByText(text: string, opts?: ByOptions): Locator {
    return this.root().getByText(text, opts);
  }
  getByLabel(text: string, opts?: ByOptions): Locator {
    return this.root().getByLabel(text, opts);
  }
  getByPlaceholder(text: string, opts?: ByOptions): Locator {
    return this.root().getByPlaceholder(text, opts);
  }
  getByTestId(id: string): Locator {
    return this.root().getByTestId(id);
  }

  async navigate(url: string): Promise<AgentCursor> {
    await this.action.navigate(url);
    return this;
  }
  goto(url: string): Promise<AgentCursor> {
    return this.navigate(url);
  }
  url(): Promise<string> {
    return this.action.getUrl();
  }
  async scroll(opts: { dy: number; dx?: number; stealth?: boolean }): Promise<AgentCursor> {
    await this.action.scroll({ dy: opts.dy, dx: opts.dx, stealth: opts.stealth ?? this.opts.stealth });
    return this;
  }
  waitForText(text: string, opts: { timeout?: number } = {}): Promise<boolean> {
    return this.action.waitFor({ text, timeoutMs: opts.timeout });
  }
  async screenshot(opts: { format?: "png" | "jpeg"; path?: string } = {}): Promise<string> {
    const data = await this.action.screenshot(opts.format ?? "png");
    if (opts.path) {
      const base64 = data.replace(/^data:[^;]+;base64,/, "");
      await writeFile(opts.path, Buffer.from(base64, "base64"));
    }
    return data;
  }
  async close(): Promise<void> {
    this.transport.close();
  }

  private ctx(): LocatorContext {
    return { action: this.action, stealth: this.opts.stealth };
  }
  private root(): Locator {
    return new Locator(this.ctx(), []);
  }
}

async function waitForConnection(t: ExtensionTransport, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!t.connected) {
    if (Date.now() >= deadline) {
      t.close();
      throw new Error(
        `agentcursor: no browser connected on ws://127.0.0.1:${port}. ` +
          `Open Chrome with the agentcursor extension loaded, or pass a different { port }.`,
      );
    }
    await delay(150);
  }
}
