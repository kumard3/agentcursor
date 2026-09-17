// src/sdk/agent-cursor.ts
import { writeFile } from "fs/promises";

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
    let z = state;
    z = Math.imul(z ^ z >>> 15, z | 1);
    z ^= z + Math.imul(z ^ z >>> 7, z | 61);
    return ((z ^ z >>> 14) >>> 0) / 4294967296;
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
function sampleKeyDelayMs(rng = createRng()) {
  const base = rng.range(55, 110);
  return { min: Math.round(base * 0.6), max: Math.round(base * 1.8) };
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
function buildTypingSchedule(text, rng, traits) {
  const base = 12e3 / traits.wpm;
  const ops = [];
  let first = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];
    let delay3 = Math.max(8, rng.gaussian(base, base * 0.35));
    if (first) {
      delay3 += traits.reactionMs * rng.range(0.6, 1.1);
      first = false;
    } else if (prev === " ") {
      delay3 += base * rng.range(1.5, 3.5);
    } else if (prev && ".?!".includes(prev)) {
      delay3 += base * rng.range(3, 6);
    } else if (rng.bool(0.06)) {
      delay3 += base * rng.range(2, 5);
    }
    if (/[a-zA-Z]/.test(ch) && rng.bool(traits.errorRate)) {
      const wrong = wrongChar(ch, rng);
      if (wrong) {
        ops.push({ t: "key", ch: wrong, delayMs: Math.round(delay3) });
        ops.push({ t: "back", delayMs: Math.round(base * rng.range(2, 5)) });
        ops.push({ t: "key", ch, delayMs: Math.round(base * rng.range(0.8, 1.4)) });
        continue;
      }
    }
    ops.push({ t: "key", ch, delayMs: Math.round(delay3) });
  }
  return ops;
}
function flattenSchedule(ops) {
  let out = "";
  for (const op of ops) {
    if (op.t === "key") out += op.ch;
    else out = out.slice(0, -1);
  }
  return out;
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
  keySchedule(text) {
    const t = this.traits();
    return buildTypingSchedule(text, this.rng, {
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

// src/util/timing.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
var sleepUntil = (perfTime) => sleep(perfTime - performance.now());
var rand = (min, max) => min + Math.random() * (max - min);

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
    const samples = generateMove(start.point, end.point, this.persona.moveOptions(end.width));
    await this.driver.drag({
      samples,
      target: end.point,
      button,
      mode: mode(stealth)
    });
  }
  /** Identification: rank on-screen elements by how well their text/name matches a query. */
  async find(text, opts = {}) {
    const snap = await this.readPage(200, true);
    await sleep(this.persona.readPauseMs(Math.min((snap.text ?? "").length, 400)));
    return rankByText(snap.elements, text).slice(0, opts.maxResults ?? 8);
  }
  /** Identification + interaction: find the best text match, then human-click it (re-reading if needed). */
  async clickText(text, opts = {}) {
    const scan = await this.readPage(200, true);
    await sleep(this.persona.readPauseMs(Math.min((scan.text ?? "").length, 400)));
    let matches = rankByText(scan.elements, text);
    for (let attempt = 0; attempt < 2 && matches.length === 0; attempt++) {
      await sleep(400);
      matches = rankByText((await this.readPage(200, true)).elements, text);
    }
    if (matches.length === 0) {
      throw new Error(
        `No element matching text "${text}". Call read_page or screenshot to see what's on the page.`
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
async function typeText(nut, text, opts) {
  if (opts.schedule?.length) {
    for (const k of scheduleToKeystrokes(opts.schedule)) {
      await nut.keyboard.type(k.ch);
      await sleep(Math.max(0, k.delayMs));
    }
    return;
  }
  for (const ch of text) {
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

// src/sdk/locator.ts
var delay = (ms) => new Promise((r) => setTimeout(r, ms));
var Locator = class _Locator {
  constructor(ctx, spec) {
    this.ctx = ctx;
    this.spec = spec;
  }
  ctx;
  spec;
  locator(css) {
    return this.step({ kind: "css", value: css });
  }
  getByRole(role, opts = {}) {
    return this.step({ kind: "role", value: role, name: opts.name, exact: opts.exact });
  }
  getByText(text, opts = {}) {
    return this.step({ kind: "text", value: text, exact: opts.exact });
  }
  getByLabel(text, opts = {}) {
    return this.step({ kind: "label", value: text, exact: opts.exact });
  }
  getByPlaceholder(text, opts = {}) {
    return this.step({ kind: "placeholder", value: text, exact: opts.exact });
  }
  getByTestId(id) {
    return this.step({ kind: "testid", value: id });
  }
  filter(opts) {
    return this.step({ kind: "filter", hasText: opts.hasText });
  }
  nth(index) {
    return this.step({ kind: "nth", index });
  }
  first() {
    return this.nth(0);
  }
  last() {
    return this.nth(-1);
  }
  async click(opts = {}) {
    const m = await this.require();
    await this.ctx.action.click({
      rect: m.rect,
      button: opts.button,
      double: opts.double,
      stealth: opts.stealth ?? this.ctx.stealth
    });
    return this;
  }
  dblclick(opts = {}) {
    return this.click({ ...opts, double: true });
  }
  async hover(opts = {}) {
    const m = await this.require();
    const c = center(m.rect);
    await this.ctx.action.hover({ x: c.x, y: c.y, stealth: opts.stealth ?? this.ctx.stealth });
    return this;
  }
  async type(text, opts = {}) {
    const m = await this.require();
    await this.ctx.action.type({ text, rect: m.rect, stealth: opts.stealth ?? this.ctx.stealth });
    return this;
  }
  async fill(text, opts = {}) {
    const m = await this.require();
    await this.ctx.action.type({ text, rect: m.rect, replace: true, stealth: opts.stealth ?? this.ctx.stealth });
    return this;
  }
  async press(key, opts = {}) {
    const m = await this.require();
    await this.ctx.action.click({ rect: m.rect, stealth: opts.stealth ?? this.ctx.stealth });
    await this.ctx.action.pressKey(key, opts.stealth ?? this.ctx.stealth);
    return this;
  }
  async dragTo(target, opts = {}) {
    const from = await this.require();
    const to = await target.require();
    await this.ctx.action.drag({ rect: from.rect }, { rect: to.rect }, "left", opts.stealth ?? this.ctx.stealth);
    return this;
  }
  async scrollIntoView() {
    await this.require();
    return this;
  }
  async boundingBox() {
    const m = await this.resolve(false);
    return m.count > 0 ? m.rect : null;
  }
  async textContent() {
    const m = await this.resolve(false);
    return m.count > 0 ? m.text : null;
  }
  async isVisible() {
    const m = await this.resolve(false);
    return m.count > 0 && m.visible;
  }
  async count() {
    const m = await this.resolve(false);
    return m.count;
  }
  async waitFor(opts = {}) {
    const state = opts.state ?? "visible";
    const deadline = Date.now() + (opts.timeout ?? 1e4);
    for (; ; ) {
      const m = await this.resolve(false, 0);
      if (m.count > 0 && (state === "attached" || m.visible)) return this;
      if (Date.now() >= deadline) {
        throw new Error(`agentcursor: waitFor(${state}) timed out for locator [${describe(this.spec)}]`);
      }
      await delay(150);
    }
  }
  step(s) {
    return new _Locator(this.ctx, [...this.spec, s]);
  }
  resolve(scrollIntoView, timeoutMs = 5e3) {
    return this.ctx.action.resolveLocator(this.spec, { timeoutMs, scrollIntoView });
  }
  async require() {
    const m = await this.resolve(true);
    if (m.count === 0) {
      throw new Error(`agentcursor: no element matched locator [${describe(this.spec)}]`);
    }
    return m;
  }
};
function center(r) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
function describe(spec) {
  return spec.map(
    (s) => s.kind === "filter" ? `filter(hasText=${s.hasText})` : s.kind === "nth" ? `nth(${s.index})` : `${s.kind}=${s.value}`
  ).join(" >> ");
}

// src/sdk/agent-cursor.ts
var delay2 = (ms) => new Promise((r) => setTimeout(r, ms));
var AgentCursor = class _AgentCursor {
  constructor(action, transport, opts) {
    this.action = action;
    this.transport = transport;
    this.opts = opts;
  }
  action;
  transport;
  opts;
  static connect(options = {}) {
    return _AgentCursor.start(options, (t) => new ExtensionDriver(t));
  }
  static os(options = {}) {
    return _AgentCursor.start(options, (t) => new OsCursorDriver(t));
  }
  static async start(options, makeDriver) {
    const port = options.port ?? DEFAULT_WS_PORT;
    const transport = new ExtensionTransport(port);
    await waitForConnection(transport, port, options.timeoutMs ?? 15e3);
    const action = new ActionService(makeDriver(transport), createPersona(options.seed));
    return new _AgentCursor(action, transport, { stealth: options.stealth ?? false });
  }
  /** Escape hatch to the lower-level action service (move_to by coords, find, clickText, etc.). */
  get actions() {
    return this.action;
  }
  locator(css) {
    return this.root().locator(css);
  }
  getByRole(role, opts) {
    return this.root().getByRole(role, opts);
  }
  getByText(text, opts) {
    return this.root().getByText(text, opts);
  }
  getByLabel(text, opts) {
    return this.root().getByLabel(text, opts);
  }
  getByPlaceholder(text, opts) {
    return this.root().getByPlaceholder(text, opts);
  }
  getByTestId(id) {
    return this.root().getByTestId(id);
  }
  async navigate(url) {
    await this.action.navigate(url);
    return this;
  }
  goto(url) {
    return this.navigate(url);
  }
  url() {
    return this.action.getUrl();
  }
  async scroll(opts) {
    await this.action.scroll({ dy: opts.dy, dx: opts.dx, stealth: opts.stealth ?? this.opts.stealth });
    return this;
  }
  waitForText(text, opts = {}) {
    return this.action.waitFor({ text, timeoutMs: opts.timeout });
  }
  async screenshot(opts = {}) {
    const data = await this.action.screenshot(opts.format ?? "png");
    if (opts.path) {
      const base64 = data.replace(/^data:[^;]+;base64,/, "");
      await writeFile(opts.path, Buffer.from(base64, "base64"));
    }
    return data;
  }
  async close() {
    this.transport.close();
  }
  ctx() {
    return { action: this.action, stealth: this.opts.stealth };
  }
  root() {
    return new Locator(this.ctx(), []);
  }
};
async function waitForConnection(t, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!t.connected) {
    if (Date.now() >= deadline) {
      t.close();
      throw new Error(
        `agentcursor: no browser connected on ws://127.0.0.1:${port}. Open Chrome with the agentcursor extension loaded, or pass a different { port }.`
      );
    }
    await delay2(150);
  }
}
export {
  ActionService,
  AgentCursor,
  ExtensionDriver,
  ExtensionTransport,
  Locator,
  OsCursorDriver,
  Persona,
  buildTypingSchedule,
  createPersona,
  createRng,
  flattenSchedule,
  generateMove,
  offCenterPoint,
  sampleDwellMs,
  sampleKeyDelayMs,
  samplePressMs,
  scheduleToKeystrokes
};
