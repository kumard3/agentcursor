import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { rankByText } from "../action/service";
import { loadNut, playPath, pressButton, pressCombo, scrollSteps, typeText } from "../drivers/nut";
import { generateMove, offCenterPoint, sampleDwellMs, samplePressMs } from "../path-engine";
import { distance } from "../path-engine/geometry";
import type { Persona } from "../persona";
import type { MouseButton, Point, Rect } from "../protocol";
import { sleep } from "../util/timing";
import { appArgs, ax, type AxApp, type AxPermissions, type AxSnapshot, type AxWindow } from "./ax";

const run = promisify(execFile);

export interface DesktopElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  rect: Rect;
  enabled?: boolean;
  focused?: boolean;
}

export interface DesktopView {
  app: AxApp;
  window: AxWindow;
  elements: DesktopElement[];
  truncated: boolean;
}

export interface DesktopTarget {
  ref?: string;
  text?: string;
  x?: number;
  y?: number;
  app?: string;
}

export interface Screenshot {
  data: string;
  mimeType: string;
  note: string;
}

export class DesktopService {
  private view: DesktopView | null = null;
  private currentPid: number | undefined;
  // Refs stick to the same control across reads of the same app, so an agent's
  // earlier ref stays valid and reads can be diffed. The value is left out of
  // the key so typing into a field does not rename it.
  private refKeys = new Map<string, string>();
  private refCounter = 0;

  constructor(private readonly persona: Persona) {}

  permissions(): Promise<AxPermissions> {
    return ax<AxPermissions>(["permissions"]);
  }

  requestPermission(kind: "accessibility" | "screen"): Promise<Partial<AxPermissions>> {
    return ax([kind === "screen" ? "request-screen" : "request-accessibility"]);
  }

  apps(): Promise<AxApp[]> {
    return ax<AxApp[]>(["apps"]);
  }

  async open(app: string): Promise<AxApp> {
    const before = (await this.apps()).find((a) => a.active)?.pid;
    await run("open", ["-a", app]).catch((e: { stderr?: string }) => {
      throw new Error(e.stderr?.trim() || `Could not open "${app}"`);
    });
    const want = app.toLowerCase();
    for (let i = 0; i < 40; i++) {
      const front = (await this.apps()).find((a) => a.active);
      const name = front?.name.toLowerCase() ?? "";
      if (front && (name === want || name.includes(want) || want.includes(name) || front.pid !== before)) {
        this.currentPid = front.pid;
        this.view = null;
        return front;
      }
      await sleep(250);
    }
    throw new Error(`Opened "${app}" but it did not come to the front.`);
  }

  async read(opts: { app?: string; max?: number } = {}): Promise<DesktopView> {
    const snap = await ax<AxSnapshot>([
      "snapshot",
      ...appArgs(opts.app ?? this.currentPid),
      "--max",
      String(opts.max ?? 150),
    ]);
    if (snap.pid !== this.currentPid) {
      this.refKeys.clear();
      this.refCounter = 0;
    }
    this.currentPid = snap.pid;
    this.view = {
      app: { name: snap.name, pid: snap.pid, bundleId: snap.bundleId },
      window: snap.window,
      truncated: snap.truncated,
      elements: snap.elements.map((e) => ({
        ref: this.refFor(e),
        role: e.role,
        name: e.name,
        value: e.value,
        rect: { x: e.x, y: e.y, width: e.w, height: e.h },
        enabled: e.enabled,
        focused: e.focused,
      })),
    };
    return this.view;
  }

  async find(text: string, opts: { app?: string; maxResults?: number } = {}): Promise<DesktopElement[]> {
    const view = await this.read({ app: opts.app, max: 400 });
    return rankByText(view.elements, text).slice(0, opts.maxResults ?? 8);
  }

  async click(t: DesktopTarget & { button?: MouseButton; double?: boolean }): Promise<string> {
    const target = await this.resolve(t);
    await this.front(target.pid);
    await this.moveHuman(target.point, target.width);
    const traits = this.persona.traits();
    await sleep(sampleDwellMs(this.persona.rng, traits.dwellScale));
    await pressButton(await loadNut(), t.button ?? "left", samplePressMs(this.persona.rng, traits.pressScale), t.double);
    return describe(target);
  }

  async move(t: DesktopTarget): Promise<string> {
    const target = await this.resolve(t);
    await this.front(target.pid);
    await this.moveHuman(target.point, target.width);
    return describe(target);
  }

  async type(opts: DesktopTarget & { value: string; clear?: boolean; submit?: boolean }): Promise<void> {
    if (opts.ref || opts.text || typeof opts.x === "number") await this.click(opts);
    else await this.front(this.currentPid);
    const nut = await loadNut();
    if (opts.clear) {
      await pressCombo(nut, process.platform === "darwin" ? "cmd+a" : "ctrl+a", 60);
      await pressCombo(nut, "backspace", 40);
    }
    this.persona.tick();
    const base = 12000 / this.persona.traits().wpm;
    await typeText(nut, opts.value, {
      schedule: this.persona.keySchedule(opts.value),
      perKeyMinMs: base * 0.6,
      perKeyMaxMs: base * 1.8,
    });
    if (opts.submit) await pressCombo(nut, "enter", samplePressMs(this.persona.rng));
  }

  async key(combo: string): Promise<void> {
    await this.front(this.currentPid);
    this.persona.tick();
    await sleep(this.persona.thinkTimeMs(0));
    await pressCombo(await loadNut(), combo, samplePressMs(this.persona.rng, this.persona.traits().pressScale));
  }

  async scroll(opts: DesktopTarget & { dy: number; dx?: number }): Promise<void> {
    if (opts.ref || opts.text || typeof opts.x === "number") {
      const target = await this.resolve(opts);
      await this.front(target.pid);
      await this.moveHuman(target.point, target.width);
    } else {
      await this.front(this.currentPid);
    }
    this.persona.tick();
    const steps = Math.max(3, Math.round(Math.abs(opts.dy || opts.dx || 0) / this.persona.rng.range(80, 140)));
    await scrollSteps(await loadNut(), opts.dx ?? 0, opts.dy, steps);
    this.view = null;
  }

  async screenshot(opts: { app?: string; ref?: string; maxWidth?: number } = {}): Promise<Screenshot> {
    let rect: Rect;
    let label: string;
    if (opts.ref) {
      const el = this.element(opts.ref);
      const pad = 40;
      rect = { x: el.rect.x - pad, y: el.rect.y - pad, width: el.rect.width + pad * 2, height: el.rect.height + pad * 2 };
      label = `around [${el.ref}]`;
    } else {
      const info = await ax<AxApp & { window: AxWindow }>(["window", ...appArgs(opts.app ?? this.currentPid)]);
      rect = { x: info.window.x, y: info.window.y, width: info.window.w, height: info.window.h };
      label = `${info.name} window`;
    }
    const dir = await mkdtemp(join(tmpdir(), "agentcursor-shot-"));
    const file = join(dir, "shot.jpg");
    try {
      await run("screencapture", ["-x", "-t", "jpg", `-R${rect.x},${rect.y},${rect.width},${rect.height}`, file]);
      const maxWidth = opts.maxWidth ?? 1024;
      if ((await imageSize(file)).width > maxWidth) {
        await run("sips", ["--resampleWidth", String(maxWidth), file]);
      }
      const size = await imageSize(file);
      const scale = rect.width / size.width;
      return {
        data: (await readFile(file)).toString("base64"),
        mimeType: "image/jpeg",
        note: `${label}: image ${size.width}x${size.height} covers screen ${rect.x},${rect.y} ${rect.width}x${rect.height}. Screen x = ${rect.x} + px*${scale.toFixed(3)}, y = ${rect.y} + py*${scale.toFixed(3)}.`,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async wiggle(): Promise<void> {
    const nut = await loadNut();
    const start = await nut.mouse.getPosition();
    let from: Point = { x: start.x, y: start.y };
    for (const to of [
      { x: start.x + 160, y: start.y - 70 },
      { x: start.x + 70, y: start.y + 100 },
      { x: start.x, y: start.y },
    ]) {
      await playPath(nut, generateMove(from, to, this.persona.moveOptions(24)));
      await sleep(150);
      from = to;
    }
  }

  private refFor(e: { role: string; name: string; x: number; y: number }): string {
    const key = `${e.role}|${e.name}|${Math.round(e.x / 8)},${Math.round(e.y / 8)}`;
    let ref = this.refKeys.get(key);
    if (!ref) {
      ref = `d${++this.refCounter}`;
      this.refKeys.set(key, ref);
    }
    return ref;
  }

  private element(ref: string): DesktopElement {
    const el = this.view?.elements.find((e) => e.ref === ref);
    if (!el) throw new Error(`Unknown ref '${ref}'. Refs expire after scrolling or switching apps; call desktop_read again.`);
    return el;
  }

  private async resolve(t: DesktopTarget): Promise<{ point: Point; width: number; pid?: number; el?: DesktopElement }> {
    if (typeof t.x === "number" && typeof t.y === "number") {
      return { point: { x: t.x, y: t.y }, width: 24, pid: this.currentPid };
    }
    let el: DesktopElement | undefined;
    if (t.ref) {
      el = this.element(t.ref);
    } else if (t.text) {
      el = (await this.find(t.text, { app: t.app, maxResults: 1 }))[0];
      if (!el) {
        throw new Error(`Nothing labelled "${t.text}" in ${this.view?.app.name ?? "the app"}. Try desktop_read or desktop_screenshot.`);
      }
    } else {
      throw new Error("Provide a ref, text, or x and y.");
    }
    const precision = this.persona.traits().precision;
    return {
      point: offCenterPoint(el.rect, this.persona.rng, precision),
      width: Math.max(Math.min(el.rect.width, el.rect.height), 8),
      pid: this.view?.app.pid,
      el,
    };
  }

  private async moveHuman(to: Point, width: number): Promise<void> {
    const nut = await loadNut();
    const pos = await nut.mouse.getPosition();
    const from = { x: pos.x, y: pos.y };
    this.persona.tick();
    await sleep(this.persona.thinkTimeMs(distance(from, to)));
    await playPath(nut, generateMove(from, to, this.persona.moveOptions(width)));
  }

  private async front(pid?: number): Promise<void> {
    if (pid) await ax(["activate", "--pid", String(pid)]).catch(() => undefined);
  }
}

function describe(target: { point: Point; el?: DesktopElement }): string {
  const at = `(${Math.round(target.point.x)}, ${Math.round(target.point.y)})`;
  return target.el ? `[${target.el.ref}] ${target.el.role} "${target.el.name}" at ${at}` : at;
}

async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  return {
    width: Number(/pixelWidth: (\d+)/.exec(stdout)?.[1] ?? 0),
    height: Number(/pixelHeight: (\d+)/.exec(stdout)?.[1] ?? 0),
  };
}

export function formatView(view: DesktopView, only?: DesktopElement[]): string {
  const w = view.window;
  const lines = [`${view.app.name} window "${w.title}" @${w.x},${w.y} ${w.w}x${w.h} (element @x,y = center)`];
  for (const e of only ?? view.elements) lines.push(formatElement(e));
  if (!only && view.truncated) lines.push("(more elements hidden; pass a larger max)");
  return lines.join("\n");
}

export function formatElement(e: DesktopElement): string {
  const name = e.name ? ` "${e.name}"` : "";
  const value = e.value ? ` value="${e.value.length > 60 ? `${e.value.slice(0, 60)}…` : e.value}"` : "";
  const flags = `${e.enabled === false ? " disabled" : ""}${e.focused ? " focused" : ""}`;
  const cx = Math.round(e.rect.x + e.rect.width / 2);
  const cy = Math.round(e.rect.y + e.rect.height / 2);
  return `[${e.ref}] ${e.role}${name}${value} @${cx},${cy}${flags}`;
}
