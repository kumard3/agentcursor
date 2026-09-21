#!/usr/bin/env node

// src/sdk/launch.ts
import { spawn } from "child_process";
import { once } from "events";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
var CHROME_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
  ]
};
function findChrome(explicit) {
  const path = explicit ?? process.env.AGENTCURSOR_CHROME ?? (CHROME_PATHS[process.platform] ?? []).find(existsSync);
  if (!path || !existsSync(path)) {
    throw new Error("agentcursor: Chrome not found. Pass { executablePath } or set AGENTCURSOR_CHROME.");
  }
  return path;
}
function extensionDir() {
  for (const rel of ["../extension", "../../extension"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, "dist", "service-worker.js"))) return dir;
  }
  throw new Error("agentcursor: built extension not found. Run `pnpm build` first.");
}
async function launchBrowser(port, options = {}) {
  const chrome = findChrome(options.executablePath);
  const realProfile = options.userDataDir;
  const profile = realProfile ?? mkdtempSync(join(tmpdir(), "agentcursor-"));
  const ext = mkdtempSync(join(tmpdir(), "agentcursor-ext-"));
  const src = extensionDir();
  for (const part of ["manifest.json", "dist", "icons"]) cpSync(join(src, part), join(ext, part), { recursive: true });
  writeFileSync(join(ext, "launch.json"), JSON.stringify({ port }));
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--password-store=basic",
    "--use-mock-keychain",
    ...options.headless ? ["--headless=new"] : [],
    ...options.accessibility ? ["--force-renderer-accessibility"] : [],
    ...options.args ?? [],
    "about:blank"
  ];
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdp = new PipeCdp(proc.stdio[3], proc.stdio[4]);
  const exited = once(proc, "exit");
  const cleanup = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      await cdp.send("Browser.close", {}, 3e3).catch(() => proc.kill());
      await Promise.race([exited, delay(5e3).then(() => proc.kill("SIGKILL"))]);
    }
    rmSync(ext, { recursive: true, force: true, maxRetries: 5 });
    if (!realProfile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    await Promise.race([
      cdp.send("Extensions.loadUnpacked", { path: ext }, 15e3),
      exited.then(() => {
        throw new Error(`agentcursor: Chrome exited during launch (${chrome})`);
      })
    ]);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { close: cleanup };
}
var delay = (ms) => new Promise((r) => setTimeout(r, ms));
var PipeCdp = class {
  constructor(out, input) {
    this.out = out;
    input.setEncoding("utf8");
    input.on("data", (chunk) => this.onData(chunk));
    input.on("error", () => void 0);
    out.on("error", () => void 0);
  }
  out;
  nextId = 1;
  buf = "";
  pending = /* @__PURE__ */ new Map();
  send(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agentcursor: CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      });
      this.out.write(`${JSON.stringify({ id, method, params })}\0`);
    });
  }
  onData(chunk) {
    this.buf += chunk;
    let end;
    while ((end = this.buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(this.buf.slice(0, end));
      this.buf = this.buf.slice(end + 1);
      const entry = msg.id === void 0 ? void 0 : this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`agentcursor: CDP ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  }
};

// src/server/proxy.ts
import { spawn as spawn2 } from "child_process";
import { openSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// src/util/timing.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
var sleepUntil = (perfTime) => sleep(perfTime - performance.now());
var rand = (min, max) => min + Math.random() * (max - min);

// src/server/create.ts
import { readFileSync, statSync } from "fs";
import { tmpdir as tmpdir3 } from "os";
import { join as join3 } from "path";
import { fileURLToPath as fileURLToPath3 } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// src/protocol/index.ts
var DEFAULT_WS_PORT = 8930;
var PROTOCOL_VERSION = 1;
function buildEvalExpression(fn, args = []) {
  const argList = args.map((a) => JSON.stringify(a) ?? "undefined").join(",");
  return `(${fn.trim()})(${argList})`;
}

// src/path-engine/geometry.ts
function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y
  };
}
function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// src/path-engine/profile.ts
function fittsDurationMs(dist, targetWidth, rng, speedFactor = 1) {
  const a = rng.range(70, 130);
  const b = rng.range(80, 150);
  const id = Math.log2(dist / Math.max(targetWidth, 6) + 1);
  return Math.max(90, (a + b * id) / speedFactor);
}
function stepCount(durationMs, rng) {
  return Math.round(clamp(durationMs / rng.range(14, 20), 8, 140));
}
function easeParam(timeFraction, skew) {
  return Math.pow(smootherstep(timeFraction), skew);
}

// src/path-engine/rng.ts
function createRng(seed) {
  let state = (seed ?? Math.floor(Math.random() * 4294967295)) >>> 0;
  const next = () => {
    state = state + 1831565813 >>> 0;
    let z3 = state;
    z3 = Math.imul(z3 ^ z3 >>> 15, z3 | 1);
    z3 ^= z3 + Math.imul(z3 ^ z3 >>> 7, z3 | 61);
    return ((z3 ^ z3 >>> 14) >>> 0) / 4294967296;
  };
  const range = (min, max) => min + (max - min) * next();
  const int = (min, max) => Math.floor(range(min, max + 1));
  const gaussian = (mean = 0, std = 1) => {
    const u = 1 - next();
    const v = next();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const skewed = (min, max, power = 2.2) => min + (max - min) * Math.pow(next(), power);
  const bool = (p) => next() < p;
  return { next, range, int, gaussian, skewed, bool };
}

// src/path-engine/index.ts
var OVERSHOOT_MIN_DISTANCE = 180;
function generateMove(from, to, options = {}) {
  const rng = options.rng ?? createRng();
  const targetWidth = options.targetWidth ?? 24;
  const allowOvershoot = options.overshoot ?? true;
  const seg = {
    targetWidth,
    correction: false,
    speedFactor: options.speedFactor ?? 1,
    curviness: options.curviness ?? 1,
    jitterAmp: options.jitterPx ?? 1.4,
    handedness: options.handedness ?? 0
  };
  const total = distance(from, to);
  const legs = [];
  if (allowOvershoot && total > OVERSHOOT_MIN_DISTANCE && rng.bool(options.overshootProb ?? 0.5)) {
    const past = overshootPoint(from, to, rng, options.overshootMag ?? 0.12);
    legs.push({ a: from, b: past, correction: false });
    legs.push({ a: past, b: to, correction: true });
  } else {
    legs.push({ a: from, b: to, correction: false });
  }
  const samples = [];
  let tOffset = 0;
  for (const leg of legs) {
    const seg2 = { ...seg, correction: leg.correction };
    for (const s of buildSegment(leg.a, leg.b, rng, seg2)) {
      samples.push({ x: s.x, y: s.y, t: s.t + tOffset });
    }
    const last = samples.at(-1);
    tOffset = (last?.t ?? tOffset) + rng.range(12, 45);
  }
  return monotonic(samples);
}
function buildSegment(a, b, rng, opts) {
  const dist = distance(a, b);
  const baseDuration = fittsDurationMs(
    dist,
    opts.correction ? Math.max(opts.targetWidth, 12) : opts.targetWidth,
    rng,
    opts.speedFactor
  );
  const duration = baseDuration * (opts.correction ? 0.55 : 1);
  const steps = stepCount(duration, rng);
  const skew = rng.range(0.85, 1.18);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(Math.hypot(dx, dy), 1e-4);
  const nx = -dy / len;
  const ny = dx / len;
  const side = opts.handedness !== 0 ? (rng.bool(0.75) ? 1 : -1) * Math.sign(opts.handedness) : rng.bool(0.5) ? 1 : -1;
  const bow = side * rng.range(dist * 0.04, dist * 0.16) * opts.curviness;
  const c1 = {
    x: a.x + dx * 0.3 + nx * bow * rng.range(0.7, 1),
    y: a.y + dy * 0.3 + ny * bow * rng.range(0.7, 1)
  };
  const c2 = {
    x: a.x + dx * 0.68 + nx * bow * rng.range(0.6, 1),
    y: a.y + dy * 0.68 + ny * bow * rng.range(0.6, 1)
  };
  const out = [];
  let tAcc = 0;
  for (let i = 0; i <= steps; i++) {
    const tf = i / steps;
    const point = cubicBezier(a, c1, c2, b, easeParam(tf, skew));
    const envelope = Math.sin(Math.PI * tf);
    if (i > 0) tAcc += duration / steps * rng.range(0.7, 1.3);
    out.push({
      x: point.x + rng.gaussian(0, opts.jitterAmp) * envelope,
      y: point.y + rng.gaussian(0, opts.jitterAmp) * envelope,
      t: tAcc
    });
  }
  out[0] = { x: a.x, y: a.y, t: 0 };
  out[out.length - 1] = { x: b.x, y: b.y, t: tAcc };
  return out;
}
function overshootPoint(from, to, rng, mag) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(Math.hypot(dx, dy), 1e-4);
  const ux = dx / len;
  const uy = dy / len;
  const over = Math.min(len * mag, 110) * rng.range(0.5, 1.1);
  const perp = rng.gaussian(0, 8);
  return { x: to.x + ux * over - uy * perp, y: to.y + uy * over + ux * perp };
}
function monotonic(samples) {
  const out = [];
  let lastT = -1;
  for (const s of samples) {
    const t = s.t <= lastT ? lastT + 1 : s.t;
    out.push({ x: s.x, y: s.y, t });
    lastT = t;
  }
  return out;
}
function offCenterPoint(rect, rng = createRng(), precision = 0.18) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const ox = clamp(
    rng.gaussian(0, rect.width * precision),
    -rect.width * 0.4,
    rect.width * 0.4
  );
  const oy = clamp(
    rng.gaussian(0, rect.height * precision),
    -rect.height * 0.4,
    rect.height * 0.4
  );
  return { x: cx + ox, y: cy + oy };
}
function sampleDwellMs(rng = createRng(), dwellScale = 1) {
  return Math.round(clamp(rng.skewed(60, 300, 2) * dwellScale, 40, 520));
}
function samplePressMs(rng = createRng(), pressScale = 1) {
  return Math.round(rng.skewed(45, 130, 1.8) * pressScale);
}

// src/persona/typing.ts
var NEIGHBORS = {
  a: "sqwz",
  b: "vghn",
  c: "xdfv",
  d: "serfcx",
  e: "wsdr",
  f: "drtgvc",
  g: "ftyhbv",
  h: "gyujnb",
  i: "ujko",
  j: "huikmn",
  k: "jiolm",
  l: "kop",
  m: "njk",
  n: "bhjm",
  o: "iklp",
  p: "ol",
  q: "wa",
  r: "edft",
  s: "awedxz",
  t: "rfgy",
  u: "yhji",
  v: "cfgb",
  w: "qase",
  x: "zsdc",
  y: "tghu",
  z: "asx"
};
function wrongChar(ch, rng) {
  const lower = ch.toLowerCase();
  const opts = NEIGHBORS[lower];
  if (!opts) return null;
  const pick = opts[rng.int(0, opts.length - 1)];
  return ch === lower ? pick : pick.toUpperCase();
}
function buildTypingSchedule(text3, rng, traits) {
  const base2 = 12e3 / traits.wpm;
  const ops = [];
  let first = true;
  for (let i = 0; i < text3.length; i++) {
    const ch = text3[i];
    const prev = text3[i - 1];
    let delay2 = Math.max(8, rng.gaussian(base2, base2 * 0.35));
    if (first) {
      delay2 += traits.reactionMs * rng.range(0.6, 1.1);
      first = false;
    } else if (prev === " ") {
      delay2 += base2 * rng.range(1.5, 3.5);
    } else if (prev && ".?!".includes(prev)) {
      delay2 += base2 * rng.range(3, 6);
    } else if (rng.bool(0.06)) {
      delay2 += base2 * rng.range(2, 5);
    }
    if (/[a-zA-Z]/.test(ch) && rng.bool(traits.errorRate)) {
      const wrong = wrongChar(ch, rng);
      if (wrong) {
        ops.push({ t: "key", ch: wrong, delayMs: Math.round(delay2) });
        ops.push({ t: "back", delayMs: Math.round(base2 * rng.range(2, 5)) });
        ops.push({ t: "key", ch, delayMs: Math.round(base2 * rng.range(0.8, 1.4)) });
        continue;
      }
    }
    ops.push({ t: "key", ch, delayMs: Math.round(delay2) });
  }
  return ops;
}
function scheduleToKeystrokes(ops) {
  const stack = [];
  for (const op of ops) {
    if (op.t === "key") stack.push({ ch: op.ch, delayMs: op.delayMs });
    else stack.pop();
  }
  return stack;
}

// src/persona/index.ts
var FATIGUE_FULL_MS = 20 * 6e4;
var FATIGUE_MAX = 0.15;
var Persona = class {
  seed;
  rng;
  base;
  actions = 0;
  startMs;
  clock;
  constructor(opts = {}) {
    this.seed = (opts.seed ?? Math.floor(Math.random() * 4294967295)) >>> 0;
    this.rng = createRng(this.seed);
    this.clock = opts.now ?? (() => Date.now());
    this.startMs = this.clock();
    this.base = sampleTraits(this.rng);
  }
  /** Advance fatigue bookkeeping; call once per action. */
  tick() {
    this.actions++;
  }
  /** 0..FATIGUE_MAX, grows with elapsed session time. */
  get fatigue() {
    return clamp((this.clock() - this.startMs) / FATIGUE_FULL_MS, 0, 1) * FATIGUE_MAX;
  }
  /** Traits after fatigue drift (slower, shakier, more hesitant over time). */
  traits() {
    const f = this.fatigue;
    return {
      ...this.base,
      speedFactor: this.base.speedFactor * (1 - f),
      jitterPx: this.base.jitterPx * (1 + 0.4 * f),
      thinkScale: this.base.thinkScale * (1 + 0.5 * f)
    };
  }
  info() {
    return { seed: this.seed, traits: this.traits(), actionCount: this.actions, fatigue: this.fatigue };
  }
  /** Cognitive delay before an action; `distancePx` is the cursor travel. */
  thinkTimeMs(distancePx = 0) {
    const t = this.traits();
    const reaction = t.reactionMs * this.rng.range(0.7, 1.3);
    const decide = Math.min(distancePx, 1200) * 0.06 * this.rng.range(0.5, 1.5);
    return Math.round((reaction + decide) * t.thinkScale);
  }
  /** Pause to "read" `chars` of freshly surfaced text, capped. */
  readPauseMs(chars) {
    const t = this.traits();
    const raw = Math.min(chars, 600) * t.readMsPerChar * this.rng.range(0.6, 1.4);
    return Math.round(clamp(raw, 120, 4e3));
  }
  moveOptions(targetWidth) {
    const t = this.traits();
    return {
      rng: this.rng,
      targetWidth,
      speedFactor: t.speedFactor,
      curviness: t.curviness,
      jitterPx: t.jitterPx,
      overshootProb: t.overshootProb,
      overshootMag: t.overshootMag,
      handedness: t.handedness
    };
  }
  keySchedule(text3) {
    const t = this.traits();
    return buildTypingSchedule(text3, this.rng, {
      wpm: t.wpm,
      errorRate: t.errorRate,
      reactionMs: t.reactionMs
    });
  }
};
function createPersona(seed, opts = {}) {
  return new Persona({ seed, ...opts });
}
function sampleTraits(rng) {
  return {
    speedFactor: rng.range(0.75, 1.35),
    curviness: rng.range(0.6, 1.5),
    jitterPx: rng.range(0.7, 2.2),
    overshootProb: rng.range(0.25, 0.7),
    overshootMag: rng.range(0.08, 0.16),
    precision: rng.range(0.1, 0.26),
    dwellScale: rng.range(0.7, 1.5),
    pressScale: rng.range(0.75, 1.4),
    wpm: rng.range(180, 420),
    errorRate: rng.range(0, 0.05),
    reactionMs: rng.range(180, 520),
    thinkScale: rng.range(0.7, 1.5),
    readMsPerChar: rng.range(8, 22),
    handedness: rng.bool(0.5) ? 1 : -1
  };
}

// src/action/service.ts
var ActionService = class {
  constructor(driver, persona) {
    this.driver = driver;
    this.persona = persona ?? createPersona();
  }
  driver;
  snapshot = null;
  lastPos = null;
  persona;
  /** The active session persona (seed + traits), for status/inspection. */
  personaInfo() {
    return this.persona.info();
  }
  async readPage(maxElements = 200, includeText = true) {
    this.snapshot = await this.driver.snapshot(maxElements, includeText);
    return this.snapshot;
  }
  async moveTo(opts) {
    await this.ensureFresh(opts.ref);
    const from = await this.ensureStart();
    const { point, width } = await this.resolveTarget(opts);
    this.persona.tick();
    await this.think(distance(from, point));
    const samples = generateMove(from, point, this.persona.moveOptions(width));
    await this.driver.move(samples, mode(opts.stealth));
    this.lastPos = point;
    return point;
  }
  async click(opts) {
    await this.ensureFresh(opts.ref);
    const from = await this.ensureStart();
    const { point, width } = await this.resolveTarget(opts);
    this.persona.tick();
    await this.think(distance(from, point));
    const t = this.persona.traits();
    const samples = generateMove(from, point, this.persona.moveOptions(width));
    await this.driver.click({
      samples,
      target: point,
      button: opts.button ?? "left",
      dblclick: opts.double ?? false,
      preClickDwellMs: sampleDwellMs(this.persona.rng, t.dwellScale),
      pressMs: samplePressMs(this.persona.rng, t.pressScale),
      mode: mode(opts.stealth)
    });
    this.lastPos = point;
    return point;
  }
  async type(opts) {
    if (opts.ref) await this.click({ ref: opts.ref, stealth: opts.stealth });
    else if (opts.rect) await this.click({ rect: opts.rect, stealth: opts.stealth });
    this.persona.tick();
    const base2 = 12e3 / this.persona.traits().wpm;
    const schedule = opts.replace ? void 0 : this.persona.keySchedule(opts.text);
    await this.driver.type({
      text: opts.text,
      ref: opts.ref,
      perKeyMinMs: Math.round(base2 * 0.6),
      perKeyMaxMs: Math.round(base2 * 1.8),
      mode: mode(opts.stealth),
      replace: opts.replace,
      schedule
    });
  }
  resolveLocator(spec, opts = {}) {
    return this.driver.resolveLocator(spec, {
      timeoutMs: opts.timeoutMs ?? 5e3,
      scrollIntoView: opts.scrollIntoView
    });
  }
  async scroll(opts) {
    this.persona.tick();
    const steps = Math.max(3, Math.round(Math.abs(opts.dy) / this.persona.rng.range(80, 140)));
    await this.driver.scroll({
      dx: opts.dx ?? 0,
      dy: opts.dy,
      steps,
      mode: mode(opts.stealth)
    });
    await sleep(this.persona.readPauseMs(Math.min(Math.abs(opts.dy) / 3, 300)));
  }
  async navigate(url) {
    this.snapshot = null;
    this.lastPos = null;
    await this.driver.navigate(url);
  }
  getUrl() {
    return this.driver.getUrl();
  }
  evaluate(fn, args = []) {
    return this.driver.evaluate(buildEvalExpression(fn, args));
  }
  async waitFor(opts) {
    await this.idleDrift();
    return this.driver.waitFor({
      ref: opts.ref,
      text: opts.text,
      timeoutMs: opts.timeoutMs ?? 1e4,
      condition: opts.condition
    });
  }
  async screenshot(format = "png") {
    return this.driver.screenshot(format);
  }
  async hover(opts = {}) {
    if (opts.ref || typeof opts.x === "number" && typeof opts.y === "number") {
      await this.moveTo({ ref: opts.ref, x: opts.x, y: opts.y, stealth: opts.stealth });
    }
    await this.driver.hover(opts);
  }
  async drag(from, to, button = "left", stealth) {
    const need = !!(from.ref || to.ref);
    if (from.ref) await this.driver.ensureVisible(from.ref);
    if (to.ref) await this.driver.ensureVisible(to.ref);
    if (need) await this.readPage();
    const start = await this.resolveTarget(from);
    const end = await this.resolveTarget(to);
    this.persona.tick();
    await this.think(distance(start.point, end.point));
    const samples = generateMove(start.point, end.point, this.persona.moveOptions(end.width));
    await this.driver.drag({
      samples,
      target: end.point,
      button,
      mode: mode(stealth)
    });
  }
  /** Identification: rank on-screen elements by how well their text/name matches a query. */
  async find(text3, opts = {}) {
    const snap = await this.readPage(200, true);
    await sleep(this.persona.readPauseMs(Math.min((snap.text ?? "").length, 400)));
    return rankByText(snap.elements, text3).slice(0, opts.maxResults ?? 8);
  }
  /** Identification + interaction: find the best text match, then human-click it (re-reading if needed). */
  async clickText(text3, opts = {}) {
    const scan = await this.readPage(200, true);
    await sleep(this.persona.readPauseMs(Math.min((scan.text ?? "").length, 400)));
    let matches = rankByText(scan.elements, text3);
    for (let attempt = 0; attempt < 2 && matches.length === 0; attempt++) {
      await sleep(400);
      matches = rankByText((await this.readPage(200, true)).elements, text3);
    }
    if (matches.length === 0) {
      throw new Error(
        `No element matching text "${text3}". Call read_page or screenshot to see what's on the page.`
      );
    }
    const matched = matches[Math.min(opts.nth ?? 0, matches.length - 1)];
    const point = await this.click({
      ref: matched.ref,
      stealth: opts.stealth,
      button: opts.button,
      double: opts.double
    });
    return { matched, point };
  }
  async pressKey(key2, stealth) {
    await this.driver.pressKey(key2, mode(stealth));
  }
  async ensureStart() {
    if (this.lastPos) return this.lastPos;
    this.lastPos = await this.driver.cursorState();
    return this.lastPos;
  }
  async ensureFresh(ref) {
    if (ref) {
      await this.driver.ensureVisible(ref);
      await this.readPage();
    }
  }
  async resolveTarget(opts) {
    const precision = this.persona.traits().precision;
    if (opts.rect) {
      const width2 = Math.max(Math.min(opts.rect.width, opts.rect.height), 8);
      return { point: offCenterPoint(opts.rect, this.persona.rng, precision), width: width2 };
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
  /** Cognitive delay before an action. */
  think(distancePx) {
    return sleep(this.persona.thinkTimeMs(distancePx));
  }
  /** A small settle move while waiting, the way a hand never sits perfectly still. */
  async idleDrift() {
    if (!this.lastPos || !this.persona.rng.bool(0.4)) return;
    const to = {
      x: this.lastPos.x + this.persona.rng.gaussian(0, 2.5),
      y: this.lastPos.y + this.persona.rng.gaussian(0, 2.5)
    };
    await this.driver.move(generateMove(this.lastPos, to, this.persona.moveOptions(6)), "content");
    this.lastPos = to;
  }
  async findElement(ref) {
    let el = this.snapshot?.elements.find((e) => e.ref === ref);
    if (!el) {
      await this.readPage();
      el = this.snapshot?.elements.find((e) => e.ref === ref);
    }
    if (!el) {
      await this.readPage();
      el = this.snapshot?.elements.find((e) => e.ref === ref);
    }
    if (!el) {
      throw new Error(
        `Element '${ref}' not found. Call read_page to refresh element refs.`
      );
    }
    return el;
  }
};
function mode(stealth) {
  return stealth ? "debugger" : "content";
}
function rankByText(elements, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
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

// src/desktop/service.ts
import { execFile as execFile2 } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir as tmpdir2 } from "os";
import { join as join2 } from "path";
import { promisify } from "util";

// src/drivers/nut.ts
var loaded = null;
function loadNut() {
  loaded ??= (async () => {
    const spec = "@nut-tree-fork/nut-js";
    try {
      const nut = await import(spec);
      nut.mouse.config.autoDelayMs = 0;
      nut.keyboard.config.autoDelayMs = 0;
      return nut;
    } catch {
      loaded = null;
      throw new Error(
        "OS cursor control needs @nut-tree-fork/nut-js. Install it with: pnpm add @nut-tree-fork/nut-js"
      );
    }
  })();
  return loaded;
}
function nutButton(nut, button) {
  if (button === "right") return nut.Button.RIGHT;
  if (button === "middle") return nut.Button.MIDDLE;
  return nut.Button.LEFT;
}
async function playPath(nut, samples, toScreen = (p) => p) {
  const start = performance.now();
  for (const s of samples) {
    await sleepUntil(start + s.t);
    const p = toScreen(s);
    await nut.mouse.setPosition(new nut.Point(p.x, p.y));
  }
}
async function pressButton(nut, button, pressMs, double = false) {
  const b = nutButton(nut, button);
  for (let i = 0; i < (double ? 2 : 1); i++) {
    if (i) await sleep(40);
    await nut.mouse.pressButton(b);
    await sleep(pressMs);
    await nut.mouse.releaseButton(b);
  }
}
async function typeText(nut, text3, opts) {
  if (opts.schedule?.length) {
    for (const k of scheduleToKeystrokes(opts.schedule)) {
      await nut.keyboard.type(k.ch);
      await sleep(Math.max(0, k.delayMs));
    }
    return;
  }
  for (const ch of text3) {
    await nut.keyboard.type(ch);
    await sleep(rand(opts.perKeyMinMs, opts.perKeyMaxMs));
  }
}
async function scrollSteps(nut, dx, dy, steps) {
  const n = Math.max(1, steps);
  for (let i = 0; i < n; i++) {
    const v = dy ? Math.max(1, Math.round(Math.abs(dy / n))) : 0;
    const h = dx ? Math.max(1, Math.round(Math.abs(dx / n))) : 0;
    if (v) await (dy >= 0 ? nut.mouse.scrollDown(v) : nut.mouse.scrollUp(v));
    if (h) await (dx >= 0 ? nut.mouse.scrollRight(h) : nut.mouse.scrollLeft(h));
    await sleep(rand(12, 28));
  }
}
var KEY_ALIASES = {
  cmd: "LeftCmd",
  command: "LeftCmd",
  meta: "LeftCmd",
  super: "LeftSuper",
  win: "LeftWin",
  ctrl: "LeftControl",
  control: "LeftControl",
  alt: "LeftAlt",
  option: "LeftAlt",
  opt: "LeftAlt",
  shift: "LeftShift",
  enter: "Enter",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  "-": "Minus",
  "=": "Equal",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "LeftBracket",
  "]": "RightBracket",
  "\\": "Backslash",
  "`": "Grave"
};
function parseKeyCombo(combo) {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Empty key combo");
  return parts.map((part) => {
    const lower = part.toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
    if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
    if (/^[0-9]$/.test(lower)) return `Num${lower}`;
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
    throw new Error(`Unknown key "${part}" in "${combo}"`);
  });
}
async function pressCombo(nut, combo, holdMs) {
  const keys = parseKeyCombo(combo).map((name) => nut.Key[name]);
  await nut.keyboard.pressKey(...keys);
  await sleep(holdMs);
  await nut.keyboard.releaseKey(...keys.reverse());
}

// src/desktop/ax.ts
import { execFile } from "child_process";
import { existsSync as existsSync2 } from "fs";
import { fileURLToPath as fileURLToPath2 } from "url";
var helperPath = fileURLToPath2(new URL("./native/agentcursor-ax", import.meta.url));
var desktopSupported = () => process.platform === "darwin" && existsSync2(helperPath);
function ax(args, timeoutMs = 2e4) {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("Desktop control currently supports macOS only."));
  }
  return new Promise((resolve, reject) => {
    execFile(helperPath, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err?.code === "ENOENT") {
        return reject(new Error(`Desktop helper missing at ${helperPath}. Run \`pnpm build\`.`));
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new Error(err?.message ?? "Desktop helper returned no output"));
      }
      if (parsed?.error) return reject(new Error(parsed.error));
      resolve(parsed);
    });
  });
}
var appArgs = (app) => app === void 0 ? [] : typeof app === "number" ? ["--pid", String(app)] : ["--app", app];

// src/desktop/service.ts
var run = promisify(execFile2);
var DesktopService = class {
  constructor(persona) {
    this.persona = persona;
  }
  persona;
  view = null;
  currentPid;
  // Refs stick to the same control across reads of the same app, so an agent's
  // earlier ref stays valid and reads can be diffed. The value is left out of
  // the key so typing into a field does not rename it.
  refKeys = /* @__PURE__ */ new Map();
  refCounter = 0;
  permissions() {
    return ax(["permissions"]);
  }
  requestPermission(kind) {
    return ax([kind === "screen" ? "request-screen" : "request-accessibility"]);
  }
  apps() {
    return ax(["apps"]);
  }
  async open(app) {
    const before = (await this.apps()).find((a) => a.active)?.pid;
    await run("open", ["-a", app]).catch((e) => {
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
  async read(opts = {}) {
    const snap = await ax([
      "snapshot",
      ...appArgs(opts.app ?? this.currentPid),
      "--max",
      String(opts.max ?? 150)
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
        focused: e.focused
      }))
    };
    return this.view;
  }
  async find(text3, opts = {}) {
    const view = await this.read({ app: opts.app, max: 400 });
    return rankByText(view.elements, text3).slice(0, opts.maxResults ?? 8);
  }
  async click(t) {
    const target2 = await this.resolve(t);
    await this.front(target2.pid);
    await this.moveHuman(target2.point, target2.width);
    const traits = this.persona.traits();
    await sleep(sampleDwellMs(this.persona.rng, traits.dwellScale));
    await pressButton(await loadNut(), t.button ?? "left", samplePressMs(this.persona.rng, traits.pressScale), t.double);
    return describe(target2);
  }
  async move(t) {
    const target2 = await this.resolve(t);
    await this.front(target2.pid);
    await this.moveHuman(target2.point, target2.width);
    return describe(target2);
  }
  async type(opts) {
    if (opts.ref || opts.text || typeof opts.x === "number") await this.click(opts);
    else await this.front(this.currentPid);
    const nut = await loadNut();
    if (opts.clear) {
      await pressCombo(nut, process.platform === "darwin" ? "cmd+a" : "ctrl+a", 60);
      await pressCombo(nut, "backspace", 40);
    }
    this.persona.tick();
    const base2 = 12e3 / this.persona.traits().wpm;
    await typeText(nut, opts.value, {
      schedule: this.persona.keySchedule(opts.value),
      perKeyMinMs: base2 * 0.6,
      perKeyMaxMs: base2 * 1.8
    });
    if (opts.submit) await pressCombo(nut, "enter", samplePressMs(this.persona.rng));
  }
  async key(combo) {
    await this.front(this.currentPid);
    this.persona.tick();
    await sleep(this.persona.thinkTimeMs(0));
    await pressCombo(await loadNut(), combo, samplePressMs(this.persona.rng, this.persona.traits().pressScale));
  }
  async scroll(opts) {
    if (opts.ref || opts.text || typeof opts.x === "number") {
      const target2 = await this.resolve(opts);
      await this.front(target2.pid);
      await this.moveHuman(target2.point, target2.width);
    } else {
      await this.front(this.currentPid);
    }
    this.persona.tick();
    const steps = Math.max(3, Math.round(Math.abs(opts.dy || opts.dx || 0) / this.persona.rng.range(80, 140)));
    await scrollSteps(await loadNut(), opts.dx ?? 0, opts.dy, steps);
    this.view = null;
  }
  async screenshot(opts = {}) {
    let rect;
    let label;
    if (opts.ref) {
      const el = this.element(opts.ref);
      const pad = 40;
      rect = { x: el.rect.x - pad, y: el.rect.y - pad, width: el.rect.width + pad * 2, height: el.rect.height + pad * 2 };
      label = `around [${el.ref}]`;
    } else {
      const info = await ax(["window", ...appArgs(opts.app ?? this.currentPid)]);
      rect = { x: info.window.x, y: info.window.y, width: info.window.w, height: info.window.h };
      label = `${info.name} window`;
    }
    const dir = await mkdtemp(join2(tmpdir2(), "agentcursor-shot-"));
    const file = join2(dir, "shot.jpg");
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
        note: `${label}: image ${size.width}x${size.height} covers screen ${rect.x},${rect.y} ${rect.width}x${rect.height}. Screen x = ${rect.x} + px*${scale.toFixed(3)}, y = ${rect.y} + py*${scale.toFixed(3)}.`
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async wiggle() {
    const nut = await loadNut();
    const start = await nut.mouse.getPosition();
    let from = { x: start.x, y: start.y };
    for (const to of [
      { x: start.x + 160, y: start.y - 70 },
      { x: start.x + 70, y: start.y + 100 },
      { x: start.x, y: start.y }
    ]) {
      await playPath(nut, generateMove(from, to, this.persona.moveOptions(24)));
      await sleep(150);
      from = to;
    }
  }
  refFor(e) {
    const key2 = `${e.role}|${e.name}|${Math.round(e.x / 8)},${Math.round(e.y / 8)}`;
    let ref = this.refKeys.get(key2);
    if (!ref) {
      ref = `d${++this.refCounter}`;
      this.refKeys.set(key2, ref);
    }
    return ref;
  }
  element(ref) {
    const el = this.view?.elements.find((e) => e.ref === ref);
    if (!el) throw new Error(`Unknown ref '${ref}'. Refs expire after scrolling or switching apps; call desktop_read again.`);
    return el;
  }
  async resolve(t) {
    if (typeof t.x === "number" && typeof t.y === "number") {
      return { point: { x: t.x, y: t.y }, width: 24, pid: this.currentPid };
    }
    let el;
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
      el
    };
  }
  async moveHuman(to, width) {
    const nut = await loadNut();
    const pos = await nut.mouse.getPosition();
    const from = { x: pos.x, y: pos.y };
    this.persona.tick();
    await sleep(this.persona.thinkTimeMs(distance(from, to)));
    await playPath(nut, generateMove(from, to, this.persona.moveOptions(width)));
  }
  async front(pid) {
    if (pid) await ax(["activate", "--pid", String(pid)]).catch(() => void 0);
  }
};
function describe(target2) {
  const at = `(${Math.round(target2.point.x)}, ${Math.round(target2.point.y)})`;
  return target2.el ? `[${target2.el.ref}] ${target2.el.role} "${target2.el.name}" at ${at}` : at;
}
async function imageSize(file) {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  return {
    width: Number(/pixelWidth: (\d+)/.exec(stdout)?.[1] ?? 0),
    height: Number(/pixelHeight: (\d+)/.exec(stdout)?.[1] ?? 0)
  };
}
function formatView(view, only) {
  const w = view.window;
  const lines = [`${view.app.name} window "${w.title}" @${w.x},${w.y} ${w.w}x${w.h} (element @x,y = center)`];
  for (const e of only ?? view.elements) lines.push(formatElement(e));
  if (!only && view.truncated) lines.push("(more elements hidden; pass a larger max)");
  return lines.join("\n");
}
function formatElement(e) {
  const name = e.name ? ` "${e.name}"` : "";
  const value = e.value ? ` value="${e.value.length > 60 ? `${e.value.slice(0, 60)}\u2026` : e.value}"` : "";
  const flags = `${e.enabled === false ? " disabled" : ""}${e.focused ? " focused" : ""}`;
  const cx = Math.round(e.rect.x + e.rect.width / 2);
  const cy = Math.round(e.rect.y + e.rect.height / 2);
  return `[${e.ref}] ${e.role}${name}${value} @${cx},${cy}${flags}`;
}

// src/drivers/extension-driver.ts
var ACTION_TIMEOUT_MS = 6e4;
var ExtensionDriver = class {
  constructor(transport) {
    this.transport = transport;
  }
  transport;
  async snapshot(maxElements, includeText) {
    return await this.transport.send({
      kind: "snapshot",
      maxElements,
      includeText
    });
  }
  async cursorState() {
    return await this.transport.send({ kind: "cursorState" });
  }
  async move(samples, mode2) {
    await this.transport.send(
      { kind: "replayMove", samples, mode: mode2 },
      ACTION_TIMEOUT_MS
    );
  }
  async click(args) {
    await this.transport.send(
      { kind: "replayClick", ...args },
      ACTION_TIMEOUT_MS
    );
  }
  async type(args) {
    await this.transport.send({ kind: "type", ...args }, ACTION_TIMEOUT_MS);
  }
  async scroll(args) {
    await this.transport.send({ kind: "scroll", ...args }, ACTION_TIMEOUT_MS);
  }
  async navigate(url) {
    await this.transport.send({ kind: "navigate", url });
  }
  async getUrl() {
    return await this.transport.send({ kind: "getUrl" });
  }
  async waitFor(args) {
    return await this.transport.send(
      { kind: "waitFor", ...args },
      args.timeoutMs + 5e3
    );
  }
  async screenshot(format = "png") {
    return await this.transport.send({ kind: "screenshot", format });
  }
  async hover(opts) {
    const mode2 = opts.stealth ? "debugger" : "content";
    await this.transport.send(
      { kind: "hover", ref: opts.ref, x: opts.x, y: opts.y, mode: mode2 },
      3e4
    );
  }
  async ensureVisible(ref, point) {
    return await this.transport.send({
      kind: "ensureVisible",
      ref,
      point
    });
  }
  async drag(args) {
    await this.transport.send({ kind: "drag", ...args }, 6e4);
  }
  async pressKey(key2, mode2) {
    await this.transport.send({ kind: "pressKey", key: key2, mode: mode2 }, 1e4);
  }
  async resolveLocator(spec, opts) {
    return await this.transport.send(
      { kind: "resolveLocator", spec, timeoutMs: opts.timeoutMs, scrollIntoView: opts.scrollIntoView },
      opts.timeoutMs + 5e3
    );
  }
  async evaluate(expression) {
    return this.transport.send({ kind: "evaluate", expression }, ACTION_TIMEOUT_MS);
  }
};

// src/drivers/coord-map.ts
function chromeOffsets(g) {
  return {
    left: Math.max(0, (g.outerWidth - g.innerWidth) / 2),
    top: g.outerHeight - g.innerHeight
  };
}
function viewportToScreen(p, g) {
  const { left, top } = chromeOffsets(g);
  return { x: g.screenX + left + p.x, y: g.screenY + top + p.y };
}
function screenToViewport(p, g) {
  const { left, top } = chromeOffsets(g);
  return { x: p.x - g.screenX - left, y: p.y - g.screenY - top };
}

// src/drivers/os-cursor-driver.ts
var OsCursorDriver = class {
  constructor(transport) {
    this.transport = transport;
  }
  transport;
  geom = null;
  async snapshot(maxElements, includeText) {
    return await this.transport.send({
      kind: "snapshot",
      maxElements,
      includeText
    });
  }
  async getUrl() {
    return await this.transport.send({ kind: "getUrl" });
  }
  async navigate(url) {
    this.geom = null;
    await this.transport.send({ kind: "navigate", url });
  }
  async waitFor(args) {
    return await this.transport.send(
      { kind: "waitFor", ...args },
      args.timeoutMs + 5e3
    );
  }
  async screenshot(format = "png") {
    return await this.transport.send({ kind: "screenshot", format });
  }
  async hover(opts) {
    await this.transport.send(
      { kind: "hover", ref: opts.ref, x: opts.x, y: opts.y, mode: "content" },
      3e4
    );
  }
  async ensureVisible(ref, point) {
    return await this.transport.send({
      kind: "ensureVisible",
      ref,
      point
    });
  }
  async drag(args) {
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
  async pressKey(key2, mode2) {
    await this.transport.send({ kind: "pressKey", key: key2, mode: mode2 });
  }
  // Locator resolution is DOM-side, so it goes through the extension bridge even
  // in OS mode (only the cursor itself is driven by nut-js).
  async resolveLocator(spec, opts) {
    return await this.transport.send(
      { kind: "resolveLocator", spec, timeoutMs: opts.timeoutMs, scrollIntoView: opts.scrollIntoView },
      opts.timeoutMs + 5e3
    );
  }
  async evaluate(expression) {
    return this.transport.send({ kind: "evaluate", expression }, 6e4);
  }
  async cursorState() {
    const nut = await loadNut();
    const pos = await nut.mouse.getPosition();
    return screenToViewport(pos, await this.geometry());
  }
  async move(samples, _mode) {
    const g = await this.geometry();
    await playPath(await loadNut(), samples, (p) => viewportToScreen(p, g));
  }
  async click(args) {
    await this.move(args.samples, args.mode);
    await sleep(args.preClickDwellMs);
    await pressButton(await loadNut(), args.button, args.pressMs, args.dblclick);
  }
  async type(args) {
    await typeText(await loadNut(), args.text, args);
  }
  async scroll(args) {
    await scrollSteps(await loadNut(), 0, args.dy, args.steps);
  }
  async geometry() {
    if (!this.geom) {
      this.geom = await this.transport.send({
        kind: "windowGeometry"
      });
    }
    return this.geom;
  }
};

// src/server/desktop-tools.ts
import { z } from "zod";

// src/util/diff.ts
function diffRead(previous, next) {
  const pending = /* @__PURE__ */ new Map();
  for (const line of previous) {
    const list = pending.get(key(line));
    if (list) list.push(line);
    else pending.set(key(line), [line]);
  }
  const added = [];
  let moved = 0;
  let unchanged = 0;
  for (const line of next) {
    const list = pending.get(key(line));
    const match = list?.shift();
    if (match === void 0) added.push(line);
    else if (match === line) unchanged++;
    else moved++;
  }
  const removed = [...pending.values()].flat();
  if (!added.length && !removed.length && !moved) return "no change since the last read";
  const summary = `(${moved ? `${moved} moved, ` : ""}${unchanged} unchanged, ${next.length} total)`;
  return [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`), summary].join("\n");
}
function key(line) {
  return line.replace(/ @-?\d+,-?\d+/, "");
}
function readOrDiff(previous, next) {
  const full = next.join("\n");
  if (!previous) return full;
  const diff = diffRead(previous, next);
  return diff.length < full.length ? diff : full;
}

// src/server/desktop-tools.ts
function text(body) {
  return { content: [{ type: "text", text: body }] };
}
var target = {
  ref: z.string().optional().describe("[dN] ref from desktop_read"),
  text: z.string().optional().describe("visible text or label to target"),
  x: z.number().optional(),
  y: z.number().optional(),
  app: z.string().optional()
};
var lastRead = /* @__PURE__ */ new WeakMap();
function registerDesktopTools(server, desktop) {
  server.registerTool(
    "desktop_apps",
    { description: "List running Mac apps; * marks the frontmost one.", inputSchema: {} },
    async () => text((await desktop.apps()).map((a) => `${a.active ? "*" : " "} ${a.name} (pid ${a.pid})`).join("\n"))
  );
  server.registerTool(
    "desktop_open",
    {
      description: "Open or switch to a Mac app by name (Notes, Slack, Finder, Safari...) and bring it to the front.",
      inputSchema: { app: z.string() }
    },
    async ({ app }) => {
      const a = await desktop.open(app);
      return text(`${a.name} (pid ${a.pid}) is frontmost`);
    }
  );
  server.registerTool(
    "desktop_read",
    {
      description: "Read an app window as compact text: buttons, fields, links, menus and visible text, each with a [dN] ref and center point. Costs far fewer tokens than a screenshot, so call it before clicking. `find` returns only the best matches for a label. Defaults to the app you last opened or read.",
      inputSchema: {
        app: z.string().optional(),
        find: z.string().optional(),
        max: z.number().int().min(1).max(500).optional(),
        changes: z.boolean().optional().describe("only what changed since your last read (refs stay valid)")
      }
    },
    async ({ app, find, max, changes }) => {
      if (find) {
        const matches = await desktop.find(find, { app });
        return text(matches.length ? matches.map(formatElement).join("\n") : `Nothing matching "${find}".`);
      }
      const lines = formatView(await desktop.read({ app, max })).split("\n");
      const body = changes ? readOrDiff(lastRead.get(desktop), lines) : lines.join("\n");
      lastRead.set(desktop, lines);
      return text(body);
    }
  );
  server.registerTool(
    "desktop_click",
    {
      description: "Move the real cursor along a human path and click: a [dN] ref, visible text/label, or screen x/y. Brings the app to the front first.",
      inputSchema: {
        ...target,
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional()
      }
    },
    async (args) => text(`clicked ${await desktop.click(args)}`)
  );
  server.registerTool(
    "desktop_move",
    {
      description: "Move the real cursor to a ref, label, or x/y without clicking (menus, tooltips, hover states).",
      inputSchema: target
    },
    async (args) => text(`moved to ${await desktop.move(args)}`)
  );
  server.registerTool(
    "desktop_type",
    {
      description: "Type with human timing. Clicks a field first when given ref, into (label) or x/y; otherwise types into the focused field. clear replaces the current text, submit presses Enter.",
      inputSchema: {
        text: z.string(),
        ref: z.string().optional(),
        into: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        app: z.string().optional(),
        clear: z.boolean().optional(),
        submit: z.boolean().optional()
      }
    },
    async ({ text: value, into, ...rest2 }) => {
      await desktop.type({ ...rest2, text: into, value });
      return text(`typed ${value.length} chars${rest2.submit ? " and pressed Enter" : ""}`);
    }
  );
  server.registerTool(
    "desktop_key",
    {
      description: "Press a key or shortcut in the current app: enter, esc, tab, up, cmd+s, cmd+shift+t, ctrl+c.",
      inputSchema: { keys: z.string() }
    },
    async ({ keys }) => {
      await desktop.key(keys);
      return text(`pressed ${keys}`);
    }
  );
  server.registerTool(
    "desktop_scroll",
    {
      description: "Scroll by dy (positive = down) and optional dx, over a ref, label or x/y (else where the cursor is). Refs expire after scrolling; desktop_read again.",
      inputSchema: { ...target, dy: z.number(), dx: z.number().optional() }
    },
    async (args) => {
      await desktop.scroll(args);
      return text(`scrolled dy=${args.dy}${args.dx ? ` dx=${args.dx}` : ""}`);
    }
  );
  server.registerTool(
    "desktop_screenshot",
    {
      description: "Screenshot one app window (or the area around a ref), downscaled. Use only when desktop_read text is not enough: canvases, images, custom-drawn UI. The reply explains how to turn image pixels into screen x/y for desktop_click.",
      inputSchema: {
        app: z.string().optional(),
        ref: z.string().optional(),
        maxWidth: z.number().int().min(200).max(2e3).optional()
      }
    },
    async (args) => {
      const shot = await desktop.screenshot(args);
      return {
        content: [
          { type: "image", data: shot.data, mimeType: shot.mimeType },
          { type: "text", text: shot.note }
        ]
      };
    }
  );
}

// src/server/tools.ts
import { z as z2 } from "zod";
function text2(body) {
  return { content: [{ type: "text", text: body }] };
}
var lastRead2 = /* @__PURE__ */ new WeakMap();
function registerTools(server, action) {
  server.registerTool(
    "read_page",
    {
      description: "Read the current page: interactive elements with stable [ref] handles, their roles/names and on-screen rectangles, plus visible text. Call before clicking or typing by ref.",
      inputSchema: {
        maxElements: z2.number().int().min(1).max(200).optional(),
        includeText: z2.boolean().optional(),
        changes: z2.boolean().optional().describe("only what changed since your last read (refs stay valid)")
      }
    },
    async ({ maxElements, includeText, changes }) => {
      const snap = await action.readPage(maxElements ?? 60, includeText ?? true);
      const lines = formatSnapshot(snap);
      const body = changes ? readOrDiff(lastRead2.get(action), lines) : lines.join("\n");
      lastRead2.set(action, lines);
      return text2(body);
    }
  );
  server.registerTool(
    "find",
    {
      description: "Identification: locate on-screen elements by their visible text or accessible name (shadow-DOM aware), the way a human scans a page. Returns ranked matches with [ref], role, and on-screen rect. Use when you don't already have a ref, then click/move_to/hover by [ref] \u2014 or use click_text to do it in one step.",
      inputSchema: {
        text: z2.string(),
        maxResults: z2.number().int().min(1).max(20).optional()
      }
    },
    async ({ text: query, maxResults }) => {
      const matches = await action.find(query, { maxResults });
      if (!matches.length) return text2(`No elements matching "${query}".`);
      return text2(matches.map(formatElement2).join("\n"));
    }
  );
  server.registerTool(
    "click_text",
    {
      description: "Identification + interaction in one step: find the element that best matches the given text/label, then human-move the cursor to it and click. Re-reads the page if the element isn't there yet. `nth` picks a later match, `stealth:true` delivers trusted events, `double` double-clicks.",
      inputSchema: {
        text: z2.string(),
        nth: z2.number().int().min(0).optional(),
        double: z2.boolean().optional(),
        stealth: z2.boolean().optional()
      }
    },
    async ({ text: query, nth, double, stealth }) => {
      const { matched, point } = await action.clickText(query, { nth, double, stealth });
      return text2(
        `clicked "${matched.name || matched.ref}" [${matched.ref}] at (${point.x.toFixed(0)}, ${point.y.toFixed(0)})`
      );
    }
  );
  server.registerTool(
    "move_to",
    {
      description: "Move the cursor to an element ([ref] from read_page) or to absolute viewport x/y along a human-like path. Does not click. stealth:true delivers trusted events via the debugger driver.",
      inputSchema: {
        ref: z2.string().optional(),
        x: z2.number().optional(),
        y: z2.number().optional(),
        stealth: z2.boolean().optional()
      }
    },
    async (args) => {
      const p = await action.moveTo(args);
      return text2(`moved to (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
    }
  );
  server.registerTool(
    "click",
    {
      description: "Human-like move + click on an element ([ref]) or x/y. Supports button, double-click, and stealth (trusted-event) mode.",
      inputSchema: {
        ref: z2.string().optional(),
        x: z2.number().optional(),
        y: z2.number().optional(),
        button: z2.enum(["left", "right", "middle"]).optional(),
        double: z2.boolean().optional(),
        stealth: z2.boolean().optional()
      }
    },
    async (args) => {
      const p = await action.click(args);
      const where = args.ref ? `'${args.ref}'` : `(${p.x.toFixed(0)}, ${p.y.toFixed(0)})`;
      return text2(`clicked ${where}`);
    }
  );
  server.registerTool(
    "type",
    {
      description: "Type text with human key timing. If a ref is given, the input is human-clicked to focus first. stealth:true uses the debugger driver.",
      inputSchema: {
        text: z2.string(),
        ref: z2.string().optional(),
        stealth: z2.boolean().optional()
      }
    },
    async (args) => {
      await action.type(args);
      return text2(`typed ${args.text.length} chars`);
    }
  );
  server.registerTool(
    "press_key",
    {
      description: "Press a single key on the focused element: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character. Use to submit (Enter), dismiss dialogs (Escape), or tab between fields. stealth:true delivers a trusted key event via the debugger driver.",
      inputSchema: {
        key: z2.string(),
        stealth: z2.boolean().optional()
      }
    },
    async ({ key: key2, stealth }) => {
      await action.pressKey(key2, stealth);
      return text2(`pressed ${key2}`);
    }
  );
  server.registerTool(
    "scroll",
    {
      description: "Scroll the page by dy (and optional dx) pixels in eased human steps.",
      inputSchema: {
        dy: z2.number(),
        dx: z2.number().optional(),
        stealth: z2.boolean().optional()
      }
    },
    async (args) => {
      await action.scroll(args);
      return text2(`scrolled dy=${args.dy}`);
    }
  );
  server.registerTool(
    "navigate",
    {
      description: "Navigate the active tab to a URL.",
      inputSchema: { url: z2.string() }
    },
    async ({ url }) => {
      await action.navigate(url);
      return text2(`navigating to ${url}`);
    }
  );
  server.registerTool(
    "get_url",
    { description: "Return the active tab's current URL.", inputSchema: {} },
    async () => text2(await action.getUrl())
  );
  server.registerTool(
    "evaluate",
    {
      description: "Run a JavaScript function in the active page and return its JSON result. Pass a function source string, e.g. `() => document.title` or `async () => (await fetch('/api/x', { method: 'POST', credentials: 'include' })).status`. Runs in the page realm via CDP, so it uses the page's own cookies/session, awaits promises, and is not blocked by the page CSP. Return value must be JSON-serializable. Use for reads and requests the UI has no button for; the debugger banner shows while it runs.",
      inputSchema: {
        function: z2.string(),
        args: z2.array(z2.any()).optional()
      }
    },
    async ({ function: fn, args }) => {
      const result = await action.evaluate(fn, args);
      return text2(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    }
  );
  server.registerTool(
    "wait_for",
    {
      description: "Wait until an element [ref] appears or some visible text is present (or specific condition), up to timeoutMs (default 10000). Supports condition: 'exists' | 'visible' | 'text'. Use in testing and automation flows for resilience on dynamic sites.",
      inputSchema: {
        ref: z2.string().optional(),
        text: z2.string().optional(),
        timeoutMs: z2.number().int().optional(),
        condition: z2.enum(["exists", "visible", "text"]).optional()
      }
    },
    async (args) => {
      const ok = await action.waitFor(args);
      return text2(ok ? "found" : "timed out");
    }
  );
  server.registerTool(
    "screenshot",
    {
      description: "Capture the visible tab as an image, scaled so 1 image pixel = 1 click coordinate. SEE the page, then click(x,y)/move_to(x,y) at coordinates read off the image. This is the vision loop (screenshot -> decide coords -> click -> screenshot) and needs no DOM refs.",
      inputSchema: {
        format: z2.enum(["png", "jpeg"]).optional()
      }
    },
    async ({ format }) => {
      const dataUrl = await action.screenshot(format ?? "png");
      const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) return text2(dataUrl);
      return { content: [{ type: "image", data: m[2], mimeType: m[1] }] };
    }
  );
  server.registerTool(
    "hover",
    {
      description: "Human-like move the cursor to an element or coordinates and fire hover events (mouseover, mouseenter). Essential for dropdowns, tooltips, navigation menus, and realistic workflow/testing automation.",
      inputSchema: {
        ref: z2.string().optional(),
        x: z2.number().optional(),
        y: z2.number().optional(),
        stealth: z2.boolean().optional()
      }
    },
    async (args) => {
      await action.hover(args);
      const where = args.ref ? `'${args.ref}'` : args.x != null ? `(${args.x},${args.y})` : "current position";
      return text2(`hovered ${where}`);
    }
  );
  server.registerTool(
    "status",
    {
      description: "Return current MCP server status, driver in use (extension or os), whether the browser bridge is connected, and the active tab URL if available. Use for health checks in long-running tests, CI workflows, and agent monitoring.",
      inputSchema: {}
    },
    async () => {
      const url = await action.getUrl().catch(() => null);
      const connected = url !== null;
      const p = action.personaInfo();
      const t = p.traits;
      return text2(
        [
          `driver: ${process.env.AGENTCURSOR_DRIVER ?? "extension"}`,
          `bridge_connected: ${connected}`,
          `active_url: ${url ?? "none (extension not connected or no http tab)"}`,
          `ws_port: ${process.env.AGENTCURSOR_WS_PORT ?? 8930}`,
          "protocol_version: 1",
          `persona_seed: ${p.seed} (set AGENTCURSOR_SEED to reproduce)`,
          `persona_actions: ${p.actionCount}`,
          `persona_fatigue: ${p.fatigue.toFixed(3)}`,
          `persona_traits: speed=${t.speedFactor.toFixed(2)} curviness=${t.curviness.toFixed(2)} jitter=${t.jitterPx.toFixed(2)}px precision=${t.precision.toFixed(2)} wpm=${Math.round(t.wpm)} errorRate=${t.errorRate.toFixed(3)}`
        ].join("\n")
      );
    }
  );
  server.registerTool(
    "drag",
    {
      description: "Perform a human-like drag from one element/ref or coords to another (e.g. for sliders, reordering, canvas drawing). Uses the realistic path engine while holding the mouse button.",
      inputSchema: {
        fromRef: z2.string().optional(),
        fromX: z2.number().optional(),
        fromY: z2.number().optional(),
        toRef: z2.string().optional(),
        toX: z2.number().optional(),
        toY: z2.number().optional(),
        button: z2.enum(["left", "right", "middle"]).optional(),
        stealth: z2.boolean().optional()
      }
    },
    async (args) => {
      await action.drag(
        { ref: args.fromRef, x: args.fromX, y: args.fromY },
        { ref: args.toRef, x: args.toX, y: args.toY },
        args.button ?? "left",
        args.stealth
      );
      return text2("dragged");
    }
  );
  server.registerPrompt(
    "human-browser-task",
    {
      description: "Guide for performing realistic, human-like browser automation tasks using agentcursor tools. Use this for any non-trivial interaction on real websites."
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `When using agentcursor:
1. Always call status and read_page first to understand the current page and connection.
2. Use [ref] from read_page for all clicks, hovers, types.
3. For complex pages, use screenshot often to ground yourself.
4. Prefer human-like: move_to or hover before click, use wait_for for dynamic content.
5. On modern sites (X, Reddit etc), the snapshot now handles shadow DOM.
6. For stealth on sensitive sites, use stealth:true (but it shows debugger banner).
7. After navigate or major changes, re-read_page.
8. Use ensureVisible implicitly via the tools (scrolls targets into view).
Be patient with SPAs - combine wait_for + read_page loops.`
          }
        }
      ]
    })
  );
}
function formatSnapshot(snap) {
  const lines = [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    `Viewport: ${snap.viewport.width}x${snap.viewport.height} scroll ${snap.viewport.scrollX},${snap.viewport.scrollY} (element @x,y = center)`,
    `Elements (${snap.elements.length}):`
  ];
  for (const e of snap.elements) lines.push(formatElement2(e));
  if (snap.text) lines.push("", "Text:", ...truncate(snap.text, 4e3).split("\n"));
  return lines;
}
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}\u2026` : s;
}
function formatElement2(e) {
  const name = e.name ? ` "${truncate(e.name, 60)}"` : "";
  const val = e.value ? ` value="${truncate(e.value, 40)}"` : "";
  const tag = e.tag && e.tag !== e.role ? ` <${e.tag}>` : "";
  const flags = `${e.visible === false ? " hidden" : ""}${e.inViewport === false ? " off-view" : ""}`;
  const cx = Math.round(e.rect.x + e.rect.width / 2);
  const cy = Math.round(e.rect.y + e.rect.height / 2);
  return `[${e.ref}] ${e.role}${name}${val}${tag} @${cx},${cy}${flags}`;
}

// src/server/transport.ts
import { randomUUID } from "crypto";
import { once as once2 } from "events";
import { WebSocket, WebSocketServer } from "ws";
var NOT_CONNECTED = "AgentCursor extension is not connected. Load the extension and open a normal browser tab.";
var ExtensionTransport = class {
  wss;
  socket = null;
  pending = /* @__PURE__ */ new Map();
  constructor(port = DEFAULT_WS_PORT) {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    this.wss.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(
          `agentcursor: port ${port} is already in use. Set AGENTCURSOR_WS_PORT to a free port.
`
        );
        process.exit(1);
      }
      process.stderr.write(`agentcursor: WebSocket server error: ${err.message}
`);
    });
    this.wss.on("connection", (ws, req) => {
      const origin = req.headers.origin;
      if (origin && !origin.startsWith("chrome-extension://")) {
        ws.close(1008, "origin not allowed");
        return;
      }
      this.socket = ws;
      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("close", () => {
        if (this.socket === ws) this.socket = null;
      });
      ws.on("error", () => void 0);
    });
  }
  /** Resolves to the bound port; pass port 0 to the constructor for a free one. */
  async listening() {
    if (!this.wss.address()) await once2(this.wss, "listening");
    return this.wss.address().port;
  }
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  send(command2, timeoutMs = 3e4) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(NOT_CONNECTED));
    }
    const id = randomUUID();
    const envelope = { v: PROTOCOL_VERSION, id, command: command2 };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command '${command2.kind}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(envelope));
    });
  }
  onMessage(raw) {
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      return;
    }
    const entry = this.pending.get(result.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(result.id);
    if (result.ok) entry.resolve(result.data);
    else entry.reject(new Error(result.error));
  }
  close() {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.wss.close();
  }
};

// src/server/create.ts
var SELF = fileURLToPath3(import.meta.url);
var BUILD_ID = Math.round(statSync(SELF).mtimeMs);
function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
function resolvePorts(env = process.env) {
  const ws = Number(env.AGENTCURSOR_WS_PORT ?? DEFAULT_WS_PORT);
  return { ws, http: Number(env.AGENTCURSOR_HTTP_PORT ?? ws + 1) };
}
function createRuntime(ports2) {
  const seedEnv = process.env.AGENTCURSOR_SEED;
  const seed = seedEnv && seedEnv.trim() !== "" && Number.isFinite(Number(seedEnv)) ? Number(seedEnv) : void 0;
  const persona = createPersona(seed);
  const extension = new ExtensionTransport(ports2.ws);
  const driver = (process.env.AGENTCURSOR_DRIVER ?? "extension").toLowerCase() === "os" ? new OsCursorDriver(extension) : new ExtensionDriver(extension);
  return {
    action: new ActionService(driver, persona),
    desktop: new DesktopService(persona),
    extension,
    persona,
    ports: ports2
  };
}
function createMcpServer(rt) {
  const tools = (process.env.AGENTCURSOR_TOOLS ?? "all").toLowerCase();
  const browser = tools !== "desktop";
  const desktop = tools !== "browser" && process.platform === "darwin";
  const server = new McpServer(
    { name: "agentcursor", version: readVersion() },
    { instructions: instructions(rt.ports, browser, desktop) }
  );
  if (browser) registerTools(server, rt.action);
  if (desktop) registerDesktopTools(server, rt.desktop);
  return server;
}
function instructions(ports2, browser, desktop) {
  return [
    "AgentCursor moves a visible, human-like cursor for you.",
    desktop && "Any Mac app: desktop_open, then desktop_read (compact text with [dN] refs, far cheaper than screenshots), then desktop_click / desktop_type / desktop_key. Use desktop_screenshot only when the text is not enough.",
    browser && "Browser tabs (needs the Chrome extension): read_page, then click / type by [ref], or click_text.",
    `If a tool reports missing permissions or a disconnected extension, send the user to http://127.0.0.1:${ports2.http} to finish setup.`
  ].filter(Boolean).join("\n");
}
var logFile = (port) => join3(tmpdir3(), `agentcursor-${port}.log`);

// src/server/proxy.ts
var base = (port) => `http://127.0.0.1:${port}`;
async function health(port) {
  try {
    const res = await fetch(`${base(port)}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
async function until(check, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(150);
  }
  return false;
}
async function ensureDaemon(port) {
  const current = await health(port);
  if (current && current.buildId >= BUILD_ID) return;
  if (current) {
    await fetch(`${base(port)}/shutdown`, { method: "POST" }).catch(() => void 0);
    await until(async () => !await health(port), 5e3);
  }
  const log = openSync(logFile(port), "a");
  spawn2(process.execPath, [SELF, "serve", "--idle-exit"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env
  }).unref();
  const ready = await until(async () => ((await health(port))?.buildId ?? 0) >= BUILD_ID, 15e3);
  if (!ready) throw new Error(`agentcursor could not start its local service on port ${port}. Log: ${logFile(port)}`);
}
async function connectClient(port) {
  const client = new Client({ name: "agentcursor-stdio", version: readVersion() });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base(port)}/mcp`)));
  return client;
}
var slim = (t) => {
  const { $schema, ...schema } = t.inputSchema;
  const { execution: _execution, ...rest2 } = t;
  return { ...rest2, inputSchema: schema };
};
var unreachable = (e) => {
  const err = e;
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(`${err?.message} ${err?.cause?.code}`);
};
async function runStdioProxy(port) {
  await ensureDaemon(port);
  let client = await connectClient(port);
  const call = async (fn) => {
    try {
      return await fn(client);
    } catch (e) {
      if (!unreachable(e)) throw e;
      await ensureDaemon(port);
      client = await connectClient(port);
      return fn(client);
    }
  };
  const server = new Server(
    { name: "agentcursor", version: readVersion() },
    { capabilities: { tools: {}, prompts: {} }, instructions: client.getInstructions() }
  );
  const long = { timeout: 15 * 6e4 };
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const res = await call((c) => c.listTools(req.params));
    return { ...res, tools: res.tools.map(slim) };
  });
  server.setRequestHandler(CallToolRequestSchema, (req) => call((c) => c.callTool(req.params, void 0, long)));
  server.setRequestHandler(ListPromptsRequestSchema, (req) => call((c) => c.listPrompts(req.params)));
  server.setRequestHandler(GetPromptRequestSchema, (req) => call((c) => c.getPrompt(req.params)));
  await server.connect(new StdioServerTransport());
  setInterval(() => void health(port), 6e4).unref();
}

// src/cli/launch.ts
function parseFlags(rest2) {
  const flags = { headless: false };
  for (let i = 0; i < rest2.length; i++) {
    const raw = rest2[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const name = raw.slice(2, eq === -1 ? void 0 : eq);
    if (name === "headless") {
      flags.headless = true;
      continue;
    }
    if (!["user-data-dir", "profile", "chrome", "executable-path", "port"].includes(name)) {
      throw new Error(`unknown flag --${name}`);
    }
    const value = eq === -1 ? rest2[++i] : raw.slice(eq + 1);
    if (value === void 0) throw new Error(`--${name} needs a value`);
    if (name === "user-data-dir" || name === "profile") flags.userDataDir = value;
    else if (name === "chrome" || name === "executable-path") flags.executablePath = value;
    else flags.port = Number(value);
  }
  return flags;
}
async function launchCli(ports2, rest2) {
  let flags;
  try {
    flags = parseFlags(rest2);
  } catch (err) {
    process.stderr.write(`agentcursor launch: ${err.message}
`);
    process.exit(1);
  }
  const wsPort = flags.port ?? ports2.ws;
  await ensureDaemon(ports2.http);
  let browser;
  try {
    browser = await launchBrowser(wsPort, {
      headless: flags.headless,
      userDataDir: flags.userDataDir,
      executablePath: flags.executablePath
    });
  } catch (err) {
    process.stderr.write(`agentcursor launch: ${err.message}
`);
    process.exit(1);
  }
  const where = flags.userDataDir ? `profile ${flags.userDataDir}` : "a throwaway profile";
  process.stderr.write(
    `agentcursor: browser up on ${where}${flags.headless ? " (headless)" : ""}, wired to ws://127.0.0.1:${wsPort}. Drive it from your agent (agentcursor read_page / click / evaluate ...). Ctrl-C to stop.
`
  );
  const stop = async () => {
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {
  });
}

// src/cli/run.ts
import { writeFile } from "fs/promises";
import { tmpdir as tmpdir4 } from "os";
import { join as join4 } from "path";
async function runTool(port, argv) {
  const name = argv[0]?.replace(/-/g, "_");
  await ensureDaemon(port);
  const client = await connectClient(port);
  const tools = (await client.listTools()).tools ?? [];
  if (!name || name === "help" || name === "tools" || name === "--help" || name === "-h") {
    process.stdout.write(usage(tools, name === "tools"));
    return 0;
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    process.stderr.write(`agentcursor: unknown command '${argv[0]}'. Try: agentcursor help
`);
    return 1;
  }
  const args = parseArgs(tool, argv.slice(1));
  const result = await client.callTool({ name, arguments: args }, void 0, { timeout: 15 * 6e4 });
  for (const part of result.content ?? []) {
    if (part.type === "text") process.stdout.write(`${part.text}
`);
    else if (part.type === "image" && part.data) process.stdout.write(`${await saveImage(part.data, part.mimeType)}
`);
  }
  return result.isError ? 1 : 0;
}
async function saveImage(data, mimeType = "image/png") {
  const ext = mimeType.includes("jpeg") ? "jpg" : "png";
  const file = join4(process.env.AGENTCURSOR_OUT ?? tmpdir4(), `agentcursor-${Date.now()}.${ext}`);
  await writeFile(file, Buffer.from(data, "base64"));
  return file;
}
function parseArgs(tool, rest2) {
  const props = tool.inputSchema.properties ?? {};
  const order = Object.keys(props);
  const args = {};
  let next = 0;
  for (let i = 0; i < rest2.length; i++) {
    const item = rest2[i];
    if (item.startsWith("--")) {
      const [flag, inline] = splitFlag(item.slice(2));
      const type = props[flag]?.type;
      if (type === "boolean" && inline === void 0) {
        const peek = rest2[i + 1];
        const explicit = peek === "true" || peek === "false";
        args[flag] = explicit ? peek === "true" : true;
        if (explicit) i++;
      } else args[flag] = coerce(inline ?? rest2[++i] ?? "", type);
      continue;
    }
    while (next < order.length && order[next] in args) next++;
    const key2 = order[next++];
    if (!key2) throw new Error(`agentcursor: too many arguments for ${tool.name}`);
    args[key2] = coerce(item, props[key2]?.type);
  }
  return args;
}
function splitFlag(s) {
  const eq = s.indexOf("=");
  return eq === -1 ? [s, void 0] : [s.slice(0, eq), s.slice(eq + 1)];
}
function coerce(value, type) {
  if (type === "number" || type === "integer") {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`agentcursor: '${value}' is not a number`);
    return n;
  }
  if (type === "boolean") return value !== "false" && value !== "0";
  return value;
}
function usage(tools, full) {
  const lines = [
    "agentcursor: a visible human cursor for browser tabs and Mac apps.",
    "",
    "  agentcursor <command> [positional...] [--flag value]",
    "",
    "Positionals fill a command's parameters in the order listed below.",
    "State (page, [refs], frontmost app) is kept by one background service, so commands chain.",
    "",
    "Browser (needs the Chrome extension):"
  ];
  const line = (t) => {
    const params = Object.entries(t.inputSchema.properties ?? {}).map(([k, v]) => v.enum ? `${k}=${v.enum.join("|")}` : k).join(" ");
    const desc = full ? `
      ${t.description ?? ""}` : "";
    return `  ${t.name.padEnd(19)} ${params}${desc}`;
  };
  for (const t of tools.filter((t2) => !t2.name.startsWith("desktop_"))) lines.push(line(t));
  const desktop = tools.filter((t) => t.name.startsWith("desktop_"));
  if (desktop.length) {
    lines.push("", "Any Mac app (computer use; read is text, not pixels):");
    for (const t of desktop) lines.push(line(t));
  }
  lines.push(
    "",
    "Also: agentcursor launch [--user-data-dir DIR] [--chrome PATH] [--headless] (attach a real-profile browser in the background)",
    "      agentcursor setup | serve | mcp (stdio MCP server) | tools (same list with full descriptions)",
    "Screenshots are written to a file and the path is printed. AGENTCURSOR_OUT sets the directory.",
    ""
  );
  return lines.join("\n");
}

// src/server/http.ts
import { createServer } from "http";
import { fileURLToPath as fileURLToPath4 } from "url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// src/setup/clients.ts
import { spawnSync } from "child_process";
import { copyFileSync, existsSync as existsSync3, mkdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { homedir } from "os";
import { delimiter, dirname, join as join5 } from "path";
var SERVER_NAME = "agentcursor";
function launchEntry(self) {
  if (self.includes(join5("_npx", ""))) {
    return { command: join5(dirname(process.execPath), "npx"), args: ["-y", "agentcursor"] };
  }
  return { command: process.execPath, args: [self] };
}
var toolPath = () => [
  process.env.PATH,
  dirname(process.execPath),
  join5(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin"
].filter(Boolean).join(delimiter);
function which(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    env: { ...process.env, PATH: toolPath() }
  });
  return r.status === 0;
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJsonEntry(path, key2, value) {
  let config = {};
  if (existsSync3(path)) {
    const raw = readFileSync2(path, "utf8");
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        `${path} is not plain JSON (it may contain comments). Add this by hand:
${JSON.stringify({ [key2]: { [SERVER_NAME]: value } }, null, 2)}`
      );
    }
    copyFileSync(path, `${path}.bak`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  config[key2] = { ...config[key2] ?? {}, [SERVER_NAME]: value };
  writeFileSync2(path, `${JSON.stringify(config, null, 2)}
`);
  return `added to ${path} (backup at .bak); restart the app to load it`;
}
function jsonClient(id, name, dir, file, key2, shape = (e) => e) {
  const path = join5(dir, file);
  return {
    id,
    name,
    detect: () => existsSync3(dir),
    configured: () => Boolean(readJson(path)?.[key2]?.[SERVER_NAME]),
    connect: (entry) => writeJsonEntry(path, key2, shape(entry))
  };
}
function cliClient(id, name, bin, addArgs, configured) {
  return {
    id,
    name,
    detect: () => which(bin),
    configured,
    connect: (entry) => {
      const args = addArgs(entry);
      const r = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env, PATH: toolPath() } });
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || `${bin} exited ${r.status}`).trim());
      return `added with \`${bin} ${args.slice(0, 4).join(" ")} ...\`; start a new session to load it`;
    }
  };
}
function appDataDir(home, ...parts) {
  if (process.platform === "darwin") return join5(home, "Library", "Application Support", ...parts);
  if (process.platform === "win32") return join5(process.env.APPDATA ?? join5(home, "AppData", "Roaming"), ...parts);
  return join5(home, ".config", ...parts);
}
function clients(home = homedir()) {
  return [
    cliClient(
      "claude-code",
      "Claude Code",
      "claude",
      (e) => ["mcp", "add", "--scope", "user", SERVER_NAME, "--", e.command, ...e.args],
      () => Boolean(readJson(join5(home, ".claude.json"))?.mcpServers?.[SERVER_NAME])
    ),
    jsonClient("cursor", "Cursor", join5(home, ".cursor"), "mcp.json", "mcpServers"),
    jsonClient("vscode", "VS Code", appDataDir(home, "Code", "User"), "mcp.json", "servers", (e) => ({ type: "stdio", ...e })),
    cliClient(
      "codex",
      "Codex",
      "codex",
      (e) => ["mcp", "add", SERVER_NAME, "--", e.command, ...e.args],
      () => {
        try {
          return /^\[mcp_servers\.agentcursor\]/m.test(readFileSync2(join5(home, ".codex", "config.toml"), "utf8"));
        } catch {
          return false;
        }
      }
    ),
    jsonClient("windsurf", "Windsurf", join5(home, ".codeium", "windsurf"), "mcp_config.json", "mcpServers"),
    jsonClient("claude-desktop", "Claude Desktop", appDataDir(home, "Claude"), "claude_desktop_config.json", "mcpServers"),
    cliClient(
      "gemini",
      "Gemini CLI",
      "gemini",
      (e) => ["mcp", "add", "--scope", "user", SERVER_NAME, e.command, ...e.args],
      () => Boolean(readJson(join5(home, ".gemini", "settings.json"))?.mcpServers?.[SERVER_NAME])
    )
  ];
}
function clientStatus(home = homedir()) {
  return clients(home).map((c) => ({ id: c.id, name: c.name, detected: c.detect(), configured: c.configured() }));
}
function connectClient2(id, entry, home = homedir()) {
  const client = clients(home).find((c) => c.id === id);
  if (!client) throw new Error(`Unknown client "${id}"`);
  return client.connect(entry);
}

// src/setup/wizard.html
var wizard_default = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>AgentCursor Setup</title>\n<style>\n  :root {\n    --bg: #070707; --panel: #101010; --line: #1f1f1f; --line-strong: #2c2c2c;\n    --text: #f2f2f2; --muted: #8a8a8a; --dim: #555; --ok: #f2f2f2; --warn: #bdbdbd;\n  }\n  * { box-sizing: border-box; }\n  body {\n    margin: 0; background: var(--bg); color: var(--text);\n    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", sans-serif;\n    background-image: radial-gradient(1200px 500px at 50% -200px, #1c1c1c 0%, transparent 70%);\n    min-height: 100vh;\n  }\n  main { max-width: 760px; margin: 0 auto; padding: 48px 16px 80px; }\n  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }\n  .brand { display: flex; align-items: center; gap: 12px; }\n  .brand svg { width: 26px; height: 26px; }\n  .brand h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }\n  .pill { font: 12px/1 ui-monospace, "SF Mono", Menlo, monospace; color: var(--muted); border: 1px solid var(--line-strong); padding: 6px 10px; border-radius: 6px; }\n  .lead { color: var(--muted); margin: -12px 0 28px; max-width: 560px; }\n  .progress { height: 2px; background: var(--line); border-radius: 2px; overflow: hidden; margin-bottom: 28px; }\n  .progress > div { height: 100%; background: linear-gradient(90deg, #6d6d6d, #fff); transition: width .4s ease; }\n  section { background: linear-gradient(180deg, #121212, var(--panel)); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }\n  section h2 { font-size: 15px; font-weight: 600; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }\n  section h2 .n { font: 11px/1 ui-monospace, Menlo, monospace; color: var(--dim); border: 1px solid var(--line-strong); border-radius: 4px; padding: 3px 5px; }\n  section > p { color: var(--muted); margin: 0 0 14px; }\n  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }\n  .row:first-of-type { border-top: 0; }\n  .row .label { display: flex; align-items: center; gap: 10px; min-width: 0; }\n  .row .sub { color: var(--dim); font-size: 12px; }\n  .mark { width: 16px; height: 16px; border: 1px solid var(--line-strong); border-radius: 4px; display: inline-grid; place-items: center; flex: none; font-size: 11px; color: var(--bg); }\n  .mark.on { background: var(--ok); border-color: var(--ok); }\n  .mark.on::after { content: "\u2713"; font-weight: 700; }\n  .state { color: var(--muted); font-size: 12px; }\n  button {\n    font: inherit; font-size: 13px; color: var(--bg); background: var(--text); border: 0; border-radius: 7px;\n    padding: 7px 12px; cursor: pointer; white-space: nowrap; box-shadow: inset 0 1px 0 rgba(255,255,255,.5);\n  }\n  button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line-strong); box-shadow: none; }\n  button:disabled { opacity: .45; cursor: default; }\n  button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }\n  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }\n  code, pre { font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }\n  pre { background: #0a0a0a; border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; margin: 8px 0 0; color: #cfcfcf; white-space: pre-wrap; word-break: break-all; }\n  .prompt { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; margin-top: 8px; color: #d9d9d9; }\n  ol { margin: 8px 0 0; padding-left: 20px; color: var(--muted); }\n  ol li { margin: 4px 0; }\n  details { margin-top: 12px; color: var(--muted); }\n  summary { cursor: pointer; }\n  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #fff; color: #000; padding: 10px 14px; border-radius: 8px; font-size: 13px; max-width: calc(100vw - 32px); opacity: 0; transition: opacity .2s; pointer-events: none; }\n  .toast.show { opacity: 1; }\n  .hidden { display: none; }\n  @media (max-width: 520px) { .row { flex-wrap: wrap; } }\n</style>\n</head>\n<body>\n<main>\n  <header>\n    <div class="brand">\n      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 3l15 7.2-6.4 1.6L9.4 18 4 3z" fill="#fff"/><path d="M13 12.2l5.5 6.3" stroke="#8a8a8a" stroke-width="1.6" stroke-linecap="round"/></svg>\n      <h1>AgentCursor</h1>\n    </div>\n    <span class="pill" id="service">connecting\u2026</span>\n  </header>\n  <p class="lead">A visible, human-like cursor your AI can use in any Mac app and in your browser. Finish the steps below once; every connected AI app shares this local service.</p>\n  <div class="progress" aria-hidden="true"><div id="bar" style="width:0%"></div></div>\n\n  <section>\n    <h2><span class="n">1</span> Connect your AI apps</h2>\n    <p>Adds AgentCursor to each app\'s MCP settings. Restart or reload the app afterwards.</p>\n    <div id="clients"></div>\n    <div class="actions"><button id="connect-all">Connect all detected</button></div>\n    <details>\n      <summary>Another app? Add it by hand</summary>\n      <pre id="manual"></pre>\n    </details>\n  </section>\n\n  <section id="desktop-section">\n    <h2><span class="n">2</span> Control any Mac app</h2>\n    <p>macOS asks you to allow this once. Grant it to the app your AI runs in (Terminal, Cursor, Claude...), then come back here.</p>\n    <div class="row"><div class="label"><span class="mark" id="ax-mark"></span><div>Accessibility<div class="sub">Read app windows and move the cursor</div></div></div><button class="ghost" id="ax-btn">Allow</button></div>\n    <div class="row"><div class="label"><span class="mark" id="sr-mark"></span><div>Screen Recording<div class="sub">Only for desktop_screenshot</div></div></div><button class="ghost" id="sr-btn">Allow</button></div>\n    <div class="actions"><button id="wiggle">Test the cursor</button></div>\n  </section>\n\n  <section>\n    <h2><span class="n">3</span> Browser tabs <span class="state">optional</span></h2>\n    <p>For web pages, load the Chrome extension once. Desktop control works without it.</p>\n    <div class="row"><div class="label"><span class="mark" id="ext-mark"></span><div>Chrome extension<div class="sub" id="ext-sub"></div></div></div><button class="ghost" id="ext-copy">Copy folder path</button></div>\n    <ol id="ext-steps">\n      <li>Open <code>chrome://extensions</code> and turn on Developer mode.</li>\n      <li>Click Load unpacked and pick the folder path you copied.</li>\n      <li>Open any normal web page. This turns green on its own.</li>\n    </ol>\n  </section>\n\n  <section>\n    <h2><span class="n">4</span> Try it</h2>\n    <p>Paste one of these into your AI app.</p>\n    <div id="prompts"></div>\n  </section>\n\n  <details>\n    <summary>Details</summary>\n    <pre id="details"></pre>\n  </details>\n</main>\n<div class="toast" id="toast" role="status" aria-live="polite"></div>\n\n<script>\n  const $ = (id) => document.getElementById(id);\n  const esc = (s) => String(s).replace(/[&<>"\']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;" })[c]);\n  let state = null;\n\n  const PROMPTS = [\n    "Use agentcursor: open Notes, create a new note and write a 3 item shopping list.",\n    "Use agentcursor: open Finder, go to Downloads and tell me the three newest files.",\n    "Use agentcursor: in my browser, open news.ycombinator.com and click the top story.",\n  ];\n\n  function toast(msg) {\n    const t = $("toast");\n    t.textContent = msg;\n    t.classList.add("show");\n    clearTimeout(toast.timer);\n    toast.timer = setTimeout(() => t.classList.remove("show"), 4000);\n  }\n\n  async function api(path, body) {\n    const res = await fetch(path, body === undefined ? {} : {\n      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),\n    });\n    const data = await res.json();\n    if (!res.ok) throw new Error(data.error || res.statusText);\n    return data;\n  }\n\n  async function busy(button, fn) {\n    button.disabled = true;\n    try { await fn(); } catch (e) { toast(e.message); } finally { button.disabled = false; refresh(); }\n  }\n\n  async function copy(text, label) {\n    try { await navigator.clipboard.writeText(text); toast(`${label} copied`); } catch { toast(text); }\n  }\n\n  function render(s) {\n    state = s;\n    $("service").textContent = `running \xB7 v${s.version}`;\n\n    const detected = s.clients.filter((c) => c.detected);\n    $("clients").innerHTML = s.clients.map((c) => `\n      <div class="row">\n        <div class="label"><span class="mark ${c.configured ? "on" : ""}"></span><div>${esc(c.name)}<div class="sub">${c.configured ? "Connected" : c.detected ? "Installed, not connected" : "Not found on this machine"}</div></div></div>\n        ${c.detected && !c.configured ? `<button class="ghost" data-client="${esc(c.id)}">Connect</button>` : ""}\n      </div>`).join("");\n    $("connect-all").disabled = !detected.some((c) => !c.configured);\n    $("manual").textContent = JSON.stringify({ mcpServers: { agentcursor: s.stdio } }, null, 2) + `\\n\\nHTTP transport: ${s.mcpUrl}`;\n\n    const d = s.desktop;\n    $("desktop-section").classList.toggle("hidden", !d.supported);\n    $("ax-mark").classList.toggle("on", d.accessibility);\n    $("sr-mark").classList.toggle("on", d.screenRecording);\n    $("ax-btn").classList.toggle("hidden", d.accessibility);\n    $("sr-btn").classList.toggle("hidden", d.screenRecording);\n    $("wiggle").disabled = !d.accessibility;\n\n    $("ext-mark").classList.toggle("on", s.extension.connected);\n    $("ext-sub").textContent = s.extension.connected ? "Connected" : s.extension.path;\n    $("ext-steps").classList.toggle("hidden", s.extension.connected);\n\n    const steps = [detected.some((c) => c.configured), !d.supported || d.accessibility, !d.supported || d.screenRecording, s.extension.connected];\n    $("bar").style.width = `${Math.round((steps.filter(Boolean).length / steps.length) * 100)}%`;\n\n    $("details").textContent = [\n      `MCP (HTTP): ${s.mcpUrl}`,\n      `MCP (stdio): ${s.stdio.command} ${s.stdio.args.join(" ")}`,\n      `Extension WebSocket: ws://127.0.0.1:${s.extension.wsPort}`,\n      `Persona seed: ${s.personaSeed}`,\n      `Service pid: ${s.pid}`,\n      `Log: ${s.logFile}`,\n    ].join("\\n");\n  }\n\n  async function refresh() {\n    try { render(await api("/api/status")); }\n    catch { $("service").textContent = "service not running: run agentcursor setup"; }\n  }\n\n  $("clients").addEventListener("click", (e) => {\n    const b = e.target.closest("button[data-client]");\n    if (b) busy(b, async () => toast((await api("/api/connect", { client: b.dataset.client })).message));\n  });\n  $("connect-all").addEventListener("click", (e) => busy(e.currentTarget, async () => {\n    const pending = state.clients.filter((c) => c.detected && !c.configured);\n    const results = [];\n    for (const c of pending) {\n      try { await api("/api/connect", { client: c.id }); results.push(`${c.name} connected`); }\n      catch (err) { results.push(`${c.name}: ${err.message}`); }\n    }\n    toast(results.join(" \xB7 "));\n  }));\n  $("ax-btn").addEventListener("click", (e) => busy(e.currentTarget, () => api("/api/permission", { kind: "accessibility" })));\n  $("sr-btn").addEventListener("click", (e) => busy(e.currentTarget, () => api("/api/permission", { kind: "screen" })));\n  $("wiggle").addEventListener("click", (e) => busy(e.currentTarget, async () => { await api("/api/test-cursor", {}); toast("That was AgentCursor moving your cursor"); }));\n  $("ext-copy").addEventListener("click", () => state && copy(state.extension.path, "Extension folder path"));\n\n  $("prompts").innerHTML = PROMPTS.map((p, i) => `<div class="prompt"><span>${esc(p)}</span><button class="ghost" data-prompt="${i}">Copy</button></div>`).join("");\n  $("prompts").addEventListener("click", (e) => {\n    const b = e.target.closest("button[data-prompt]");\n    if (b) copy(PROMPTS[Number(b.dataset.prompt)], "Prompt");\n  });\n\n  refresh();\n  setInterval(refresh, 2000);\n</script>\n</body>\n</html>\n';

// src/server/guard.ts
function isAllowedRequest(host, origin, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!host || !hosts.includes(host)) return false;
  return origin === void 0 || hosts.some((h) => origin === `http://${h}`);
}

// src/server/http.ts
function serve(rt, opts = {}) {
  const port = rt.ports.http;
  let lastSeen = Date.now();
  const server = createServer(async (req, res) => {
    lastSeen = Date.now();
    if (!isAllowedRequest(req.headers.host, req.headers.origin, port)) {
      return json(res, 403, { error: "Only local requests from this machine are allowed." });
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    try {
      if (path === "/mcp") return await handleMcp(rt, req, res);
      if (req.method === "GET") {
        if (path === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end(wizard_default);
        }
        if (path === "/health") return json(res, 200, health2());
        if (path === "/api/status") return json(res, 200, await status(rt));
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (path === "/api/connect") {
          return json(res, 200, { message: connectClient2(String(body.client), launchEntry(SELF)) });
        }
        if (path === "/api/permission") {
          return json(res, 200, await rt.desktop.requestPermission(body.kind === "screen" ? "screen" : "accessibility"));
        }
        if (path === "/api/test-cursor") {
          await rt.desktop.wiggle();
          return json(res, 200, { ok: true });
        }
        if (path === "/shutdown") {
          json(res, 200, { ok: true });
          setTimeout(() => process.exit(0), 50);
          return;
        }
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
    }
  });
  if (opts.idleExitMs) {
    const idle = opts.idleExitMs;
    setInterval(() => {
      if (Date.now() - lastSeen > idle) process.exit(0);
    }, 15e3).unref();
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      process.stderr.write(
        `agentcursor: serving MCP at http://127.0.0.1:${port}/mcp, setup page http://127.0.0.1:${port}, extension WebSocket ws://127.0.0.1:${rt.ports.ws}, persona seed ${rt.persona.seed}
`
      );
      resolve();
    });
  });
}
async function handleMcp(rt, req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { jsonrpc: "2.0", error: { code: -32e3, message: "Method not allowed." }, id: null });
  }
  const server = createMcpServer(rt);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: void 0, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
function health2() {
  return { ok: true, version: readVersion(), buildId: BUILD_ID, pid: process.pid };
}
async function status(rt) {
  const supported = desktopSupported();
  const permissions = supported ? await rt.desktop.permissions().catch(() => null) : null;
  return {
    ...health2(),
    platform: process.platform,
    mcpUrl: `http://127.0.0.1:${rt.ports.http}/mcp`,
    stdio: launchEntry(SELF),
    logFile: logFile(rt.ports.http),
    personaSeed: rt.persona.seed,
    extension: {
      connected: rt.extension.connected,
      wsPort: rt.ports.ws,
      path: fileURLToPath4(new URL("../extension", import.meta.url))
    },
    desktop: {
      supported,
      accessibility: permissions?.accessibility ?? false,
      screenRecording: permissions?.screenRecording ?? false
    },
    clients: clientStatus()
  };
}
function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 65536) req.destroy(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// src/setup/cli.ts
import { spawn as spawn3 } from "child_process";
async function setup(port, argv) {
  await ensureDaemon(port);
  const all = argv.includes("--all");
  const only = argv.find((a) => a.startsWith("--client="))?.slice("--client=".length).split(",");
  const entry = launchEntry(SELF);
  console.log("AI apps on this machine:");
  for (const c of clients()) {
    if (!c.detect()) continue;
    let state = c.configured() ? "connected" : "not connected";
    if (state === "not connected" && (all || only?.includes(c.id))) {
      try {
        state = `connected (${c.connect(entry)})`;
      } catch (e) {
        state = `failed: ${e.message}`;
      }
    }
    console.log(`  ${c.name.padEnd(15)} ${state}`);
  }
  const url = `http://127.0.0.1:${port}`;
  console.log(`
Setup page: ${url}`);
  console.log("Connect everything at once: agentcursor setup --all");
  if (!argv.includes("--no-open")) openUrl(url);
}
function openUrl(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn3(cmd, args, { stdio: "ignore", detached: true }).unref();
}

// src/index.ts
var [command = "mcp", ...rest] = process.argv.slice(2);
var ports = resolvePorts();
if (command === "serve") {
  await serve(createRuntime(ports), { idleExitMs: rest.includes("--idle-exit") ? 10 * 6e4 : void 0 });
} else if (command === "setup") {
  await setup(ports.http, rest);
  process.exit(0);
} else if (command === "launch") {
  await launchCli(ports, rest);
} else if (command === "mcp") {
  await runStdioProxy(ports.http);
} else {
  process.exit(await runTool(ports.http, [command, ...rest]));
}
