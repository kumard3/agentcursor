import type {
  LocatorMatch,
  LocatorSpec,
  MouseButton,
  PageElement,
  PageSnapshot,
  Point,
  Rect,
} from "../protocol";
import type { BrowserDriver } from "../drivers/driver";
import {
  generateMove,
  offCenterPoint,
  sampleDwellMs,
  samplePressMs,
  type MoveOptions,
} from "../path-engine";
import { distance } from "../path-engine/geometry";
import { createPersona, type Persona, type PersonaInfo } from "../persona";
import { sleep } from "../util/timing";

interface TargetOpts {
  ref?: string;
  x?: number;
  y?: number;
  rect?: Rect;
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
  private readonly persona: Persona;

  constructor(private readonly driver: BrowserDriver, persona?: Persona) {
    this.persona = persona ?? createPersona();
  }

  /** The active session persona (seed + traits), for status/inspection. */
  personaInfo(): PersonaInfo {
    return this.persona.info();
  }

  async readPage(maxElements = 200, includeText = true): Promise<PageSnapshot> {
    this.snapshot = await this.driver.snapshot(maxElements, includeText);
    return this.snapshot;
  }

  async moveTo(opts: TargetOpts & { stealth?: boolean }): Promise<Point> {
    await this.ensureFresh(opts.ref);
    const from = await this.ensureStart();
    const { point, width } = await this.resolveTarget(opts);
    this.persona.tick();
    await this.think(distance(from, point));
    const samples = generateMove(from, point, this.moveParams(width));
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
    this.persona.tick();
    await this.think(distance(from, point));
    const t = this.persona.traits();
    const samples = generateMove(from, point, this.moveParams(width));
    await this.driver.click({
      samples,
      target: point,
      button: opts.button ?? "left",
      dblclick: opts.double ?? false,
      preClickDwellMs: sampleDwellMs(this.persona.rng, t.dwellScale),
      pressMs: samplePressMs(this.persona.rng, t.pressScale),
      mode: mode(opts.stealth),
    });
    this.lastPos = point;
    return point;
  }

  async type(opts: {
    text: string;
    ref?: string;
    rect?: Rect;
    replace?: boolean;
    stealth?: boolean;
  }): Promise<void> {
    if (opts.ref) await this.click({ ref: opts.ref, stealth: opts.stealth });
    else if (opts.rect) await this.click({ rect: opts.rect, stealth: opts.stealth });
    this.persona.tick();
    const base = 12000 / this.persona.traits().wpm;
    // `replace` keeps the whole-string insert path (and skips typos) so controlled
    // editors like Draft.js stay correct; otherwise send the persona schedule.
    const schedule = opts.replace ? undefined : this.persona.keySchedule(opts.text);
    await this.driver.type({
      text: opts.text,
      ref: opts.ref,
      perKeyMinMs: Math.round(base * 0.6),
      perKeyMaxMs: Math.round(base * 1.8),
      mode: mode(opts.stealth),
      replace: opts.replace,
      schedule,
    });
  }

  resolveLocator(
    spec: LocatorSpec,
    opts: { timeoutMs?: number; scrollIntoView?: boolean } = {},
  ): Promise<LocatorMatch> {
    return this.driver.resolveLocator(spec, {
      timeoutMs: opts.timeoutMs ?? 5_000,
      scrollIntoView: opts.scrollIntoView,
    });
  }

  async scroll(opts: {
    dy: number;
    dx?: number;
    stealth?: boolean;
  }): Promise<void> {
    this.persona.tick();
    const steps = Math.max(3, Math.round(Math.abs(opts.dy) / this.persona.rng.range(80, 140)));
    await this.driver.scroll({
      dx: opts.dx ?? 0,
      dy: opts.dy,
      steps,
      mode: mode(opts.stealth),
    });
    // pause to take in the newly revealed content
    await sleep(this.persona.readPauseMs(Math.min(Math.abs(opts.dy) / 3, 300)));
  }

  async navigate(url: string): Promise<void> {
    this.snapshot = null;
    this.lastPos = null;
    await this.driver.navigate(url);
  }

  getUrl(): Promise<string> {
    return this.driver.getUrl();
  }

  async waitFor(opts: {
    ref?: string;
    text?: string;
    timeoutMs?: number;
    condition?: "exists" | "visible" | "text";
  }): Promise<boolean> {
    await this.idleDrift();
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
    this.persona.tick();
    await this.think(distance(start.point, end.point));
    const samples = generateMove(start.point, end.point, this.moveParams(end.width));
    await this.driver.drag({
      samples,
      target: end.point,
      button,
      mode: mode(stealth),
    });
  }

  /** Identification: rank on-screen elements by how well their text/name matches a query. */
  async find(text: string, opts: { maxResults?: number } = {}): Promise<PageElement[]> {
    const snap = await this.readPage(200, true);
    await sleep(this.persona.readPauseMs(Math.min((snap.text ?? "").length, 400)));
    return rankByText(snap.elements, text).slice(0, opts.maxResults ?? 8);
  }

  /** Identification + interaction: find the best text match, then human-click it (re-reading if needed). */
  async clickText(
    text: string,
    opts: { stealth?: boolean; nth?: number; button?: MouseButton; double?: boolean } = {},
  ): Promise<{ matched: PageElement; point: Point }> {
    const scan = await this.readPage(200, true);
    await sleep(this.persona.readPauseMs(Math.min((scan.text ?? "").length, 400)));
    let matches = rankByText(scan.elements, text);
    for (let attempt = 0; attempt < 2 && matches.length === 0; attempt++) {
      await sleep(400);
      matches = rankByText((await this.readPage(200, true)).elements, text);
    }
    if (matches.length === 0) {
      throw new Error(
        `No element matching text "${text}". Call read_page or screenshot to see what's on the page.`,
      );
    }
    const matched = matches[Math.min(opts.nth ?? 0, matches.length - 1)]!;
    const point = await this.click({
      ref: matched.ref,
      stealth: opts.stealth,
      button: opts.button,
      double: opts.double,
    });
    return { matched, point };
  }

  async pressKey(key: string, stealth?: boolean): Promise<void> {
    await this.driver.pressKey(key, mode(stealth));
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
    const precision = this.persona.traits().precision;
    if (opts.rect) {
      const width = Math.max(Math.min(opts.rect.width, opts.rect.height), 8);
      return { point: offCenterPoint(opts.rect, this.persona.rng, precision), width };
    }
    if (typeof opts.x === "number" && typeof opts.y === "number") {
      return { point: { x: opts.x, y: opts.y }, width: 24 };
    }
    if (!opts.ref) {
      throw new Error("Provide either a `ref` or explicit `x`/`y` coordinates.");
    }
    const el = await this.findElement(opts.ref);
    const width = Math.max(Math.min(el.rect.width, el.rect.height), 8);
    return { point: offCenterPoint(el.rect, this.persona.rng, precision), width };
  }

  /** Persona-shaped options for the path engine (one coherent motor signature). */
  private moveParams(targetWidth: number): MoveOptions {
    const t = this.persona.traits();
    return {
      rng: this.persona.rng,
      targetWidth,
      speedFactor: t.speedFactor,
      curviness: t.curviness,
      jitterPx: t.jitterPx,
      overshootProb: t.overshootProb,
      overshootMag: t.overshootMag,
      handedness: t.handedness,
    };
  }

  /** Cognitive delay before an action. */
  private think(distancePx: number): Promise<void> {
    return sleep(this.persona.thinkTimeMs(distancePx));
  }

  /** A small settle move while waiting, the way a hand never sits perfectly still. */
  private async idleDrift(): Promise<void> {
    if (!this.lastPos || !this.persona.rng.bool(0.4)) return;
    const to = {
      x: this.lastPos.x + this.persona.rng.gaussian(0, 2.5),
      y: this.lastPos.y + this.persona.rng.gaussian(0, 2.5),
    };
    await this.driver.move(generateMove(this.lastPos, to, this.moveParams(6)), "content");
    this.lastPos = to;
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

/** Rank elements by how well their accessible name / value matches a text query. */
function rankByText(elements: PageElement[], query: string): PageElement[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ el: PageElement; score: number }> = [];
  for (const el of elements) {
    const name = (el.name ?? "").toLowerCase();
    const val = (el.value ?? "").toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (val.includes(q)) score = 40;
    if (score === 0) continue;
    if (el.visible) score += 5;
    if (el.inViewport) score += 5;
    scored.push({ el, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.el);
}
