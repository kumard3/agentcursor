import { writeFile } from "node:fs/promises";
import { DesktopService, formatElement, formatView, type DesktopElement, type DesktopView } from "../desktop/service";
import { createPersona } from "../persona";
import type { MouseButton } from "../protocol";

export interface DesktopOptions {
  /** Persona seed. Same seed reproduces the same motion and typing. */
  seed?: number;
  /**
   * Post input straight to the target app: your own pointer never moves, the app is never
   * raised, and every Desktop gets a cursor of its own, so runs can happen while you work.
   */
  background?: boolean;
  /** Draw this session's cursor on screen, optionally with a colour and name. */
  showCursor?: boolean | { color?: string; label?: string };
}

/** A [dN] ref, or the visible text/label of a control. */
export type DesktopQuery = string | { ref?: string; text?: string; x?: number; y?: number; app?: string };

const isRef = (s: string) => /^d\d+$/.test(s);
const target = (q: DesktopQuery) => (typeof q === "string" ? (isRef(q) ? { ref: q } : { text: q }) : q);

/**
 * Computer use: drive any Mac app with the real cursor, reading the window as
 * text from the accessibility tree instead of screenshots. Same engine, persona
 * and reads as the desktop_* MCP tools.
 */
export class Desktop {
  private constructor(private readonly service: DesktopService) {}

  static async open(app?: string, options: DesktopOptions = {}): Promise<Desktop> {
    const d = new Desktop(
      new DesktopService(createPersona(options.seed), {
        background: options.background,
        showCursor: options.showCursor,
      }),
    );
    if (app) await d.service.open(app);
    return d;
  }

  /** Escape hatch to the lower-level service (same object the MCP tools use). */
  get actions(): DesktopService {
    return this.service;
  }

  apps() {
    return this.service.apps();
  }
  permissions() {
    return this.service.permissions();
  }
  activate(app: string) {
    return this.service.open(app);
  }

  /** The window as compact text with [dN] refs: far fewer tokens than a screenshot. */
  async read(opts: { app?: string; max?: number } = {}): Promise<string> {
    return formatView(await this.service.read(opts));
  }
  /** Structured form of read(), when you want to assert on elements yourself. */
  view(opts: { app?: string; max?: number } = {}): Promise<DesktopView> {
    return this.service.read(opts);
  }
  /** Only the elements matching a label: a handful of tokens instead of a whole window. */
  async find(text: string, opts: { app?: string; maxResults?: number } = {}): Promise<string> {
    const matches = await this.service.find(text, opts);
    return matches.length ? matches.map(formatElement).join("\n") : `Nothing matching "${text}".`;
  }
  elements(text: string, opts: { app?: string; maxResults?: number } = {}): Promise<DesktopElement[]> {
    return this.service.find(text, opts);
  }

  click(q: DesktopQuery, opts: { button?: MouseButton; double?: boolean } = {}): Promise<string> {
    return this.service.click({ ...target(q), ...opts });
  }
  dblclick(q: DesktopQuery): Promise<string> {
    return this.service.click({ ...target(q), double: true });
  }
  move(q: DesktopQuery): Promise<string> {
    return this.service.move(target(q));
  }
  async type(value: string, opts: { into?: DesktopQuery; clear?: boolean; submit?: boolean } = {}): Promise<void> {
    await this.service.type({ ...(opts.into ? target(opts.into) : {}), value, clear: opts.clear, submit: opts.submit });
  }
  key(combo: string): Promise<void> {
    return this.service.key(combo);
  }
  async scroll(opts: { dy: number; dx?: number; over?: DesktopQuery }): Promise<void> {
    await this.service.scroll({ ...(opts.over ? target(opts.over) : {}), dy: opts.dy, dx: opts.dx });
  }

  /** Window screenshot, downscaled. Use when the text read is not enough. */
  async screenshot(opts: { app?: string; ref?: string; maxWidth?: number; path?: string } = {}): Promise<string> {
    const shot = await this.service.screenshot(opts);
    if (opts.path) await writeFile(opts.path, Buffer.from(shot.data, "base64"));
    return opts.path ?? `data:${shot.mimeType};base64,${shot.data}`;
  }

  /** Stops drawing this session's cursor. */
  close(): void {
    this.service.close();
  }

  /** Waits for text to appear in the window. Returns false on timeout. */
  async waitForText(text: string, opts: { app?: string; timeout?: number } = {}): Promise<boolean> {
    const deadline = Date.now() + (opts.timeout ?? 10_000);
    for (;;) {
      if ((await this.service.find(text, { app: opts.app, maxResults: 1 })).length > 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
