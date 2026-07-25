#!/usr/bin/env node

// src/index.ts
import { readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
function createRng(seed2) {
  let state = (seed2 ?? Math.floor(Math.random() * 4294967295)) >>> 0;
  const next = () => {
    state = state + 1831565813 >>> 0;
    let z2 = state;
    z2 = Math.imul(z2 ^ z2 >>> 15, z2 | 1);
    z2 ^= z2 + Math.imul(z2 ^ z2 >>> 7, z2 | 61);
    return ((z2 ^ z2 >>> 14) >>> 0) / 4294967296;
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
function buildTypingSchedule(text2, rng, traits) {
  const base = 12e3 / traits.wpm;
  const ops = [];
  let first = true;
  for (let i = 0; i < text2.length; i++) {
    const ch = text2[i];
    const prev = text2[i - 1];
    let delay = Math.max(8, rng.gaussian(base, base * 0.35));
    if (first) {
      delay += traits.reactionMs * rng.range(0.6, 1.1);
      first = false;
    } else if (prev === " ") {
      delay += base * rng.range(1.5, 3.5);
    } else if (prev && ".?!".includes(prev)) {
      delay += base * rng.range(3, 6);
    } else if (rng.bool(0.06)) {
      delay += base * rng.range(2, 5);
    }
    if (/[a-zA-Z]/.test(ch) && rng.bool(traits.errorRate)) {
      const wrong = wrongChar(ch, rng);
      if (wrong) {
        ops.push({ t: "key", ch: wrong, delayMs: Math.round(delay) });
        ops.push({ t: "back", delayMs: Math.round(base * rng.range(2, 5)) });
        ops.push({ t: "key", ch, delayMs: Math.round(base * rng.range(0.8, 1.4)) });
        continue;
      }
    }
    ops.push({ t: "key", ch, delayMs: Math.round(delay) });
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
  keySchedule(text2) {
    const t = this.traits();
    return buildTypingSchedule(text2, this.rng, {
      wpm: t.wpm,
      errorRate: t.errorRate,
      reactionMs: t.reactionMs
    });
  }
};
function createPersona(seed2, opts = {}) {
  return new Persona({ seed: seed2, ...opts });
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

// src/util/timing.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
var sleepUntil = (perfTime) => sleep(perfTime - performance.now());
var rand = (min, max) => min + Math.random() * (max - min);

// src/action/service.ts
var ActionService = class {
  constructor(driver2, persona2) {
    this.driver = driver2;
    this.persona = persona2 ?? createPersona();
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
    const samples = generateMove(from, point, this.moveParams(width));
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
    const samples = generateMove(from, point, this.moveParams(width));
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
    const base = 12e3 / this.persona.traits().wpm;
    const schedule = opts.replace ? void 0 : this.persona.keySchedule(opts.text);
    await this.driver.type({
      text: opts.text,
      ref: opts.ref,
      perKeyMinMs: Math.round(base * 0.6),
      perKeyMaxMs: Math.round(base * 1.8),
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
    const samples = generateMove(start.point, end.point, this.moveParams(end.width));
    await this.driver.drag({
      samples,
      target: end.point,
      button,
      mode: mode(stealth)
    });
  }
  /** Identification: rank on-screen elements by how well their text/name matches a query. */
  async find(text2, opts = {}) {
    const snap = await this.readPage(200, true);
    await sleep(this.persona.readPauseMs(Math.min((snap.text ?? "").length, 400)));
    return rankByText(snap.elements, text2).slice(0, opts.maxResults ?? 8);
  }
  /** Identification + interaction: find the best text match, then human-click it (re-reading if needed). */
  async clickText(text2, opts = {}) {
    const scan = await this.readPage(200, true);
    await sleep(this.persona.readPauseMs(Math.min((scan.text ?? "").length, 400)));
    let matches = rankByText(scan.elements, text2);
    for (let attempt = 0; attempt < 2 && matches.length === 0; attempt++) {
      await sleep(400);
      matches = rankByText((await this.readPage(200, true)).elements, text2);
    }
    if (matches.length === 0) {
      throw new Error(
        `No element matching text "${text2}". Call read_page or screenshot to see what's on the page.`
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
  async pressKey(key, stealth) {
    await this.driver.pressKey(key, mode(stealth));
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
  /** Persona-shaped options for the path engine (one coherent motor signature). */
  moveParams(targetWidth) {
    const t = this.persona.traits();
    return {
      rng: this.persona.rng,
      targetWidth,
      speedFactor: t.speedFactor,
      curviness: t.curviness,
      jitterPx: t.jitterPx,
      overshootProb: t.overshootProb,
      overshootMag: t.overshootMag,
      handedness: t.handedness
    };
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
    await this.driver.move(generateMove(this.lastPos, to, this.moveParams(6)), "content");
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
  async pressKey(key, mode2) {
    await this.transport.send({ kind: "pressKey", key, mode: mode2 }, 1e4);
  }
  async resolveLocator(spec, opts) {
    return await this.transport.send(
      { kind: "resolveLocator", spec, timeoutMs: opts.timeoutMs, scrollIntoView: opts.scrollIntoView },
      opts.timeoutMs + 5e3
    );
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
async function loadNut() {
  const spec = "@nut-tree-fork/nut-js";
  try {
    return await import(spec);
  } catch {
    throw new Error(
      "The OS-cursor driver needs @nut-tree-fork/nut-js. Install it with: pnpm add @nut-tree-fork/nut-js"
    );
  }
}
var OsCursorDriver = class {
  constructor(transport) {
    this.transport = transport;
  }
  transport;
  nut = null;
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
  async pressKey(key, mode2) {
    await this.transport.send({ kind: "pressKey", key, mode: mode2 });
  }
  // Locator resolution is DOM-side, so it goes through the extension bridge even
  // in OS mode (only the cursor itself is driven by nut-js).
  async resolveLocator(spec, opts) {
    return await this.transport.send(
      { kind: "resolveLocator", spec, timeoutMs: opts.timeoutMs, scrollIntoView: opts.scrollIntoView },
      opts.timeoutMs + 5e3
    );
  }
  async cursorState() {
    const nut = await this.ensureNut();
    const pos = await nut.mouse.getPosition();
    return screenToViewport(pos, await this.geometry());
  }
  async move(samples, _mode) {
    const nut = await this.ensureNut();
    const g = await this.geometry();
    const start = performance.now();
    for (const s of samples) {
      await sleepUntil(start + s.t);
      const screen = viewportToScreen(s, g);
      await nut.mouse.setPosition(new nut.Point(screen.x, screen.y));
    }
  }
  async click(args) {
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
  async type(args) {
    const nut = await this.ensureNut();
    nut.keyboard.config.autoDelayMs = 0;
    if (args.schedule?.length) {
      for (const k of scheduleToKeystrokes(args.schedule)) {
        await nut.keyboard.type(k.ch);
        await sleep(Math.max(0, k.delayMs));
      }
      return;
    }
    for (const ch of args.text) {
      await nut.keyboard.type(ch);
      await sleep(rand(args.perKeyMinMs, args.perKeyMaxMs));
    }
  }
  async scroll(args) {
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
  async ensureNut() {
    if (!this.nut) {
      this.nut = await loadNut();
      this.nut.mouse.config.autoDelayMs = 0;
    }
    return this.nut;
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
function nutButton(nut, button) {
  if (button === "right") return nut.Button.RIGHT;
  if (button === "middle") return nut.Button.MIDDLE;
  return nut.Button.LEFT;
}

// src/protocol/index.ts
var DEFAULT_WS_PORT = 8930;
var PROTOCOL_VERSION = 1;

// src/server/transport.ts
import { randomUUID } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
var NOT_CONNECTED = "AgentCursor extension is not connected. Load the extension and open a normal browser tab.";
var ExtensionTransport = class {
  wss;
  socket = null;
  pending = /* @__PURE__ */ new Map();
  constructor(port2 = DEFAULT_WS_PORT) {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: port2 });
    this.wss.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(
          `agentcursor: port ${port2} is already in use. Set AGENTCURSOR_WS_PORT to a free port.
`
        );
        process.exit(1);
      }
      process.stderr.write(`agentcursor: WebSocket server error: ${err.message}
`);
    });
    this.wss.on("connection", (ws) => {
      this.socket = ws;
      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("close", () => {
        if (this.socket === ws) this.socket = null;
      });
      ws.on("error", () => void 0);
    });
  }
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  send(command, timeoutMs = 3e4) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(NOT_CONNECTED));
    }
    const id = randomUUID();
    const envelope = { v: PROTOCOL_VERSION, id, command };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command '${command.kind}' timed out after ${timeoutMs}ms`));
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

// src/server/tools.ts
import { z } from "zod";
function text(body) {
  return { content: [{ type: "text", text: body }] };
}
function registerTools(server2, action2) {
  server2.registerTool(
    "read_page",
    {
      description: "Read the current page: interactive elements with stable [ref] handles, their roles/names and on-screen rectangles, plus visible text. Call before clicking or typing by ref.",
      inputSchema: {
        maxElements: z.number().int().min(1).max(200).optional(),
        includeText: z.boolean().optional()
      }
    },
    async ({ maxElements, includeText }) => {
      const snap = await action2.readPage(maxElements ?? 60, includeText ?? true);
      return text(formatSnapshot(snap));
    }
  );
  server2.registerTool(
    "find",
    {
      description: "Identification: locate on-screen elements by their visible text or accessible name (shadow-DOM aware), the way a human scans a page. Returns ranked matches with [ref], role, and on-screen rect. Use when you don't already have a ref, then click/move_to/hover by [ref] \u2014 or use click_text to do it in one step.",
      inputSchema: {
        text: z.string(),
        maxResults: z.number().int().min(1).max(20).optional()
      }
    },
    async ({ text: query, maxResults }) => {
      const matches = await action2.find(query, { maxResults });
      if (!matches.length) return text(`No elements matching "${query}".`);
      return text(matches.map(formatElement).join("\n"));
    }
  );
  server2.registerTool(
    "click_text",
    {
      description: "Identification + interaction in one step: find the element that best matches the given text/label, then human-move the cursor to it and click. Re-reads the page if the element isn't there yet. `nth` picks a later match, `stealth:true` delivers trusted events, `double` double-clicks.",
      inputSchema: {
        text: z.string(),
        nth: z.number().int().min(0).optional(),
        double: z.boolean().optional(),
        stealth: z.boolean().optional()
      }
    },
    async ({ text: query, nth, double, stealth }) => {
      const { matched, point } = await action2.clickText(query, { nth, double, stealth });
      return text(
        `clicked "${matched.name || matched.ref}" [${matched.ref}] at (${point.x.toFixed(0)}, ${point.y.toFixed(0)})`
      );
    }
  );
  server2.registerTool(
    "move_to",
    {
      description: "Move the cursor to an element ([ref] from read_page) or to absolute viewport x/y along a human-like path. Does not click. stealth:true delivers trusted events via the debugger driver.",
      inputSchema: {
        ref: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        stealth: z.boolean().optional()
      }
    },
    async (args) => {
      const p = await action2.moveTo(args);
      return text(`moved to (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
    }
  );
  server2.registerTool(
    "click",
    {
      description: "Human-like move + click on an element ([ref]) or x/y. Supports button, double-click, and stealth (trusted-event) mode.",
      inputSchema: {
        ref: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional(),
        stealth: z.boolean().optional()
      }
    },
    async (args) => {
      const p = await action2.click(args);
      const where = args.ref ? `'${args.ref}'` : `(${p.x.toFixed(0)}, ${p.y.toFixed(0)})`;
      return text(`clicked ${where}`);
    }
  );
  server2.registerTool(
    "type",
    {
      description: "Type text with human key timing. If a ref is given, the input is human-clicked to focus first. stealth:true uses the debugger driver.",
      inputSchema: {
        text: z.string(),
        ref: z.string().optional(),
        stealth: z.boolean().optional()
      }
    },
    async (args) => {
      await action2.type(args);
      return text(`typed ${args.text.length} chars`);
    }
  );
  server2.registerTool(
    "press_key",
    {
      description: "Press a single key on the focused element: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character. Use to submit (Enter), dismiss dialogs (Escape), or tab between fields. stealth:true delivers a trusted key event via the debugger driver.",
      inputSchema: {
        key: z.string(),
        stealth: z.boolean().optional()
      }
    },
    async ({ key, stealth }) => {
      await action2.pressKey(key, stealth);
      return text(`pressed ${key}`);
    }
  );
  server2.registerTool(
    "scroll",
    {
      description: "Scroll the page by dy (and optional dx) pixels in eased human steps.",
      inputSchema: {
        dy: z.number(),
        dx: z.number().optional(),
        stealth: z.boolean().optional()
      }
    },
    async (args) => {
      await action2.scroll(args);
      return text(`scrolled dy=${args.dy}`);
    }
  );
  server2.registerTool(
    "navigate",
    {
      description: "Navigate the active tab to a URL.",
      inputSchema: { url: z.string() }
    },
    async ({ url }) => {
      await action2.navigate(url);
      return text(`navigating to ${url}`);
    }
  );
  server2.registerTool(
    "get_url",
    { description: "Return the active tab's current URL.", inputSchema: {} },
    async () => text(await action2.getUrl())
  );
  server2.registerTool(
    "wait_for",
    {
      description: "Wait until an element [ref] appears or some visible text is present (or specific condition), up to timeoutMs (default 10000). Supports condition: 'exists' | 'visible' | 'text'. Use in testing and automation flows for resilience on dynamic sites.",
      inputSchema: {
        ref: z.string().optional(),
        text: z.string().optional(),
        timeoutMs: z.number().int().optional(),
        condition: z.enum(["exists", "visible", "text"]).optional()
      }
    },
    async (args) => {
      const ok = await action2.waitFor(args);
      return text(ok ? "found" : "timed out");
    }
  );
  server2.registerTool(
    "screenshot",
    {
      description: "Capture the visible tab as an image, scaled so 1 image pixel = 1 click coordinate. SEE the page, then click(x,y)/move_to(x,y) at coordinates read off the image. This is the vision loop (screenshot -> decide coords -> click -> screenshot) and needs no DOM refs.",
      inputSchema: {
        format: z.enum(["png", "jpeg"]).optional()
      }
    },
    async ({ format }) => {
      const dataUrl = await action2.screenshot(format ?? "png");
      const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) return text(dataUrl);
      return { content: [{ type: "image", data: m[2], mimeType: m[1] }] };
    }
  );
  server2.registerTool(
    "hover",
    {
      description: "Human-like move the cursor to an element or coordinates and fire hover events (mouseover, mouseenter). Essential for dropdowns, tooltips, navigation menus, and realistic workflow/testing automation.",
      inputSchema: {
        ref: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        stealth: z.boolean().optional()
      }
    },
    async (args) => {
      await action2.hover(args);
      const where = args.ref ? `'${args.ref}'` : args.x != null ? `(${args.x},${args.y})` : "current position";
      return text(`hovered ${where}`);
    }
  );
  server2.registerTool(
    "status",
    {
      description: "Return current MCP server status, driver in use (extension or os), whether the browser bridge is connected, and the active tab URL if available. Use for health checks in long-running tests, CI workflows, and agent monitoring.",
      inputSchema: {}
    },
    async () => {
      const url = await action2.getUrl().catch(() => null);
      const connected = url !== null;
      const p = action2.personaInfo();
      const t = p.traits;
      return text(
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
  server2.registerTool(
    "drag",
    {
      description: "Perform a human-like drag from one element/ref or coords to another (e.g. for sliders, reordering, canvas drawing). Uses the realistic path engine while holding the mouse button.",
      inputSchema: {
        fromRef: z.string().optional(),
        fromX: z.number().optional(),
        fromY: z.number().optional(),
        toRef: z.string().optional(),
        toX: z.number().optional(),
        toY: z.number().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        stealth: z.boolean().optional()
      }
    },
    async (args) => {
      await action2.drag(
        { ref: args.fromRef, x: args.fromX, y: args.fromY },
        { ref: args.toRef, x: args.toX, y: args.toY },
        args.button ?? "left",
        args.stealth
      );
      return text("dragged");
    }
  );
  server2.registerPrompt(
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
    `Viewport: ${snap.viewport.width}x${snap.viewport.height} (scroll ${snap.viewport.scrollX},${snap.viewport.scrollY}, dpr ${snap.viewport.devicePixelRatio})`,
    `Elements (${snap.elements.length}):`
  ];
  for (const e of snap.elements) {
    const r = e.rect;
    const name = e.name ? ` "${truncate(e.name, 60)}"` : "";
    const val = e.value ? ` value="${truncate(e.value, 40)}"` : "";
    const vis = e.visible !== void 0 ? e.visible ? " visible" : " hidden" : "";
    const vp = e.inViewport !== void 0 ? e.inViewport ? " in-view" : " off-view" : "";
    lines.push(
      `  [${e.ref}] ${e.role}${name} <${e.tag}>${val} @ ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}${vis}${vp}`
    );
  }
  if (snap.text) lines.push("", "Text:", truncate(snap.text, 4e3));
  return lines.join("\n");
}
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}\u2026` : s;
}
function formatElement(e) {
  const r = e.rect;
  const name = e.name ? ` "${truncate(e.name, 60)}"` : "";
  const vp = e.inViewport === false ? " off-view" : "";
  return `  [${e.ref}] ${e.role}${name} <${e.tag}> @ ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}${vp}`;
}

// src/index.ts
var port = Number(process.env.AGENTCURSOR_WS_PORT ?? DEFAULT_WS_PORT);
var driverKind = (process.env.AGENTCURSOR_DRIVER ?? "extension").toLowerCase();
var seedEnv = process.env.AGENTCURSOR_SEED;
var seed = seedEnv && seedEnv.trim() !== "" && Number.isFinite(Number(seedEnv)) ? Number(seedEnv) : void 0;
var persona = createPersona(seed);
var wsTransport = new ExtensionTransport(port);
var driver = driverKind === "os" ? new OsCursorDriver(wsTransport) : new ExtensionDriver(wsTransport);
var action = new ActionService(driver, persona);
function readVersion() {
  try {
    return JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ).version;
  } catch {
    return "0.0.0";
  }
}
var server = new McpServer({ name: "agentcursor", version: readVersion() });
registerTools(server, action);
await server.connect(new StdioServerTransport());
process.stderr.write(
  `agentcursor: MCP ready (stdio, ${driverKind} driver); extension WebSocket on ws://127.0.0.1:${port}
`
);
process.stderr.write(
  `agentcursor: persona seed ${persona.seed} (set AGENTCURSOR_SEED=${persona.seed} to reproduce this person)
`
);
