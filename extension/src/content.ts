import type {
  Command,
  CommandEnvelope,
  CursorSample,
  MouseButton,
  PageElement,
  PageSnapshot,
  Point,
} from "../../src/protocol";
import { CursorOverlay } from "./cursor-overlay";
import { rand, sleep, sleepUntil, smooth } from "./timing";

const overlay = new CursorOverlay();
const refMap = new Map<string, Element>();

chrome.runtime.onMessage.addListener((msg: CommandEnvelope, _sender, reply) => {
  if (!msg?.command) return;
  handle(msg.command)
    .then((data) => reply({ ok: true, data }))
    .catch((err: unknown) => reply({ ok: false, error: errorText(err) }));
  return true;
});

async function handle(cmd: Command): Promise<unknown> {
  switch (cmd.kind) {
    case "snapshot":
      return buildSnapshot(cmd.maxElements, cmd.includeText);
    case "cursorState":
      return cursorState();
    case "windowGeometry":
      return {
        screenX: window.screenX,
        screenY: window.screenY,
        innerWidth,
        innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        devicePixelRatio,
      };
    case "replayMove":
      await replayMove(cmd.samples);
      return null;
    case "replayClick":
      await replayClick(cmd.samples, cmd.target, cmd.button, cmd.dblclick, cmd.preClickDwellMs, cmd.pressMs);
      return null;
    case "type":
      await typeText(cmd.text, cmd.ref, cmd.perKeyMinMs, cmd.perKeyMaxMs);
      return null;
    case "scroll":
      await scrollPage(cmd.dx, cmd.dy, cmd.steps);
      return null;
    case "waitFor":
      return waitFor(cmd.ref, cmd.text, cmd.timeoutMs, cmd.condition);
    case "getUrl":
      return location.href;
    case "screenshot":
      // handled in service worker
      return null;
    case "hover":
      await handleHover(cmd.ref, cmd.x, cmd.y);
      return null;
    case "ensureVisible":
      await ensureVisible(cmd.ref, cmd.point);
      return null;
    case "drag":
      await replayDrag(cmd.samples, cmd.target, cmd.button);
      return null;
    case "showCursorPath":
      await showCursorPath(cmd.samples);
      return null;
    default:
      throw new Error(`content script cannot handle '${cmd.kind}'`);
  }
}

function cursorState(): Point {
  const p = overlay.pos;
  return p.x || p.y ? p : { x: innerWidth / 2, y: innerHeight / 2 };
}

async function replayMove(samples: CursorSample[]): Promise<void> {
  const start = performance.now();
  for (const s of samples) {
    await sleepUntil(start + s.t);
    overlay.moveTo(s.x, s.y);
    const target = document.elementFromPoint(s.x, s.y) ?? document.documentElement;
    firePointer(target, "pointermove", s.x, s.y, 0);
    fireMouse(target, "mousemove", s.x, s.y, 0);
  }
}

// Visual-only overlay glide for stealth mode; CDP delivers the real events.
async function showCursorPath(samples: CursorSample[]): Promise<void> {
  const start = performance.now();
  for (const s of samples) {
    await sleepUntil(start + s.t);
    overlay.moveTo(s.x, s.y);
  }
}

async function replayClick(
  samples: CursorSample[],
  target: Point,
  button: MouseButton,
  dblclick: boolean,
  preClickDwellMs: number,
  pressMs: number,
): Promise<void> {
  await replayMove(samples);
  await sleep(preClickDwellMs);
  const el = document.elementFromPoint(target.x, target.y) ?? document.body;
  const b = buttonIndex(button);
  pressSequence(el, target, b, pressMs);
  await sleep(pressMs);
  releaseSequence(el, target, b, 1);
  if (el instanceof HTMLElement) el.focus?.();
  if (dblclick) {
    pressSequence(el, target, b, pressMs);
    releaseSequence(el, target, b, 2);
    fireMouse(el, "dblclick", target.x, target.y, b);
  }
}

function pressSequence(el: Element, p: Point, b: number, _pressMs: number): void {
  firePointer(el, "pointerdown", p.x, p.y, b);
  fireMouse(el, "mousedown", p.x, p.y, b);
}

function releaseSequence(el: Element, p: Point, b: number, clickCount: number): void {
  fireMouse(el, "mouseup", p.x, p.y, b);
  firePointer(el, "pointerup", p.x, p.y, b);
  fireMouse(el, "click", p.x, p.y, b, clickCount);
}

async function typeText(
  text: string,
  ref: string | undefined,
  perKeyMinMs: number,
  perKeyMaxMs: number,
): Promise<void> {
  const el = (ref ? refMap.get(ref) : document.activeElement) as HTMLElement | null;
  if (el && ref) el.focus();
  for (const ch of text) {
    dispatchKey(el, "keydown", ch);
    insertChar(el, ch);
    dispatchKey(el, "keyup", ch);
    await sleep(rand(perKeyMinMs, perKeyMaxMs));
  }
}

async function scrollPage(dx: number, dy: number, steps: number): Promise<void> {
  const count = Math.max(1, steps);
  for (let i = 1; i <= count; i++) {
    const frac = smooth(i / count) - smooth((i - 1) / count);
    const sx = dx * frac;
    const sy = dy * frac;
    window.scrollBy(sx, sy);
    const at = overlay.pos;
    const el = document.elementFromPoint(at.x || innerWidth / 2, at.y || innerHeight / 2) ?? document.documentElement;
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaX: sx, deltaY: sy, bubbles: true, cancelable: true, composed: true }),
    );
    await sleep(rand(12, 28));
  }
}

async function waitFor(
  ref: string | undefined,
  text: string | undefined,
  timeoutMs: number,
  condition?: "exists" | "visible" | "text",
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  const effectiveCondition = condition || (ref ? "visible" : "text"); // default to visible for refs (better for UIs)
  while (performance.now() < deadline) {
    if (ref) {
      const el = refMap.get(ref);
      if (el) {
        if (effectiveCondition === "exists") return true;
        if (effectiveCondition === "visible" && isVisible(el)) return true;
      }
    }
    if (text && document.body.innerText.includes(text)) return true;
    await sleep(120); // slightly smarter poll interval
  }
  return false;
}

async function handleHover(ref?: string, x?: number, y?: number): Promise<void> {
  await ensureVisible(ref, x != null && y != null ? { x, y } : undefined);

  let targetX: number;
  let targetY: number;
  let targetEl: Element | null = null;

  if (typeof x === "number" && typeof y === "number") {
    targetX = x;
    targetY = y;
  } else if (ref) {
    const el = refMap.get(ref);
    if (!el) {
      throw new Error(`Element ref '${ref}' not found. Call read_page first.`);
    }
    const rect = el.getBoundingClientRect();
    targetX = rect.x + rect.width / 2;
    targetY = rect.y + rect.height / 2;
    targetEl = el;
  } else {
    throw new Error("Provide ref or x/y for hover");
  }

  overlay.moveTo(targetX, targetY);

  const el = targetEl || (document.elementFromPoint(targetX, targetY) ?? document.documentElement);
  firePointer(el, "pointermove", targetX, targetY, 0);
  fireMouse(el, "mousemove", targetX, targetY, 0);

  el.dispatchEvent(
    new MouseEvent("mouseover", {
      bubbles: true,
      cancelable: true,
      clientX: targetX,
      clientY: targetY,
      composed: true,
      view: window,
    }),
  );
  el.dispatchEvent(
    new MouseEvent("mouseenter", {
      bubbles: false,
      cancelable: true,
      clientX: targetX,
      clientY: targetY,
      composed: true,
      view: window,
    }),
  );
}

async function ensureVisible(ref?: string, point?: Point): Promise<void> {
  let el: Element | null = null;
  if (ref) {
    el = refMap.get(ref) || null;
  }
  if (!el && point) {
    el = document.elementFromPoint(point.x, point.y);
  }
  if (!el) return;
  if (isFullyInViewport(el)) return;
  if (typeof (el as any).scrollIntoView === "function") {
    (el as HTMLElement).scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "auto",
    });
    await sleep(60);
  }
}

async function replayDrag(
  samples: CursorSample[],
  target: Point,
  button: MouseButton,
): Promise<void> {
  // DRY: start with press, replay the human move samples (with button down), then release
  const elStart = document.elementFromPoint(samples[0]?.x || 0, samples[0]?.y || 0) ?? document.body;
  const b = buttonIndex(button);
  pressSequence(elStart, samples[0] || target, b, 50);
  await replayMove(samples); // the path with button held
  const elEnd = document.elementFromPoint(target.x, target.y) ?? document.body;
  releaseSequence(elEnd, target, b, 1);
}

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=tab]",
  "[role=menuitem]",
  "[contenteditable=true]",
  "[contenteditable='']",
  "summary",
].join(",");

/**
 * Collects elements matching the selector, traversing into shadow DOMs.
 * This makes read_page work on modern sites (X/Twitter, Reddit, design systems, etc.)
 * that use web components.
 */
function collectInteractiveDeep(selector: string, max: number): Element[] {
  const results: Element[] = [];
  const visited = new WeakSet<Element>();

  function walk(node: Node | ShadowRoot | Document): void {
    if (results.length >= max) return;

    if (node instanceof Element) {
      if (visited.has(node)) return;
      visited.add(node);

      if (node.matches(selector)) {
        results.push(node);
      }

      // Recurse into shadow root if present
      if (node.shadowRoot) {
        walk(node.shadowRoot);
      }
    }

    // Walk child elements (works for Document, ShadowRoot, and Element)
    const children = (node as any).children;
    if (children && typeof children.length === "number") {
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child) walk(child);
      }
    }
  }

  walk(document);
  return results;
}

function buildSnapshot(maxElements: number, includeText: boolean): PageSnapshot {
  refMap.clear();
  const elements: PageElement[] = [];
  let n = 0;

  // Use deep collection so we find elements inside shadow roots (critical for X.com, Reddit, etc.)
  const candidates = collectInteractiveDeep(INTERACTIVE_SELECTOR, maxElements * 3);

  for (const el of candidates) {
    if (n >= maxElements) break;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
      continue;
    }
    if (!isVisible(el)) continue;

    const ref = `e${n + 1}`;
    refMap.set(ref, el);
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: getBetterName(el),  // improved with DRY getBetterName (aria-labelledby, data-testid, etc.)
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      editable: isEditable(el),
      value: valueOf(el),
      visible: true,
      inViewport: isInViewport(el),
    });
    n++;
  }
  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollX: Math.round(scrollX),
      scrollY: Math.round(scrollY),
      devicePixelRatio,
    },
    elements,
    text: includeText ? document.body.innerText.slice(0, 8000) : "",
  };
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") return (el as HTMLInputElement).type || "textbox";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  return tag;
}

// DRY visibility and viewport helpers (used in snapshot, wait_for, ensureVisible)
function isVisible(el: Element): boolean {
  const rect = (el as HTMLElement).getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && parseFloat(style.opacity) > 0;
}

function isInViewport(el: Element, viewportHeight: number = innerHeight, viewportWidth: number = innerWidth): boolean {
  const rect = (el as HTMLElement).getBoundingClientRect();
  return rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
}

function isFullyInViewport(el: Element): boolean {
  const rect = (el as HTMLElement).getBoundingClientRect();
  return rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
}

function getBetterName(el: Element): string {
  // aria-label first
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();

  // aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) {
      const labelText = (labelEl.textContent ?? "").trim().replace(/\s+/g, " ");
      if (labelText) return labelText.slice(0, 80);
    }
  }

  // data-testid (common in tests and modern apps)
  const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
  if (testId) return testId;

  if (el instanceof HTMLInputElement) {
    if (el.placeholder) return el.placeholder;
    if (el.name) return el.name;
  }

  // title or img alt
  const title = el.getAttribute("title");
  if (title) return title.trim().slice(0, 80);

  const imgAlt = el.querySelector("img")?.getAttribute("alt");
  if (imgAlt) return imgAlt.trim().slice(0, 80);

  // fallback to text
  const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
  if (text) return text.slice(0, 80);

  return "";
}

function isEditable(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return !el.disabled && !el.readOnly;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

function valueOf(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return undefined;
    return el.value || undefined;
  }
  if (el instanceof HTMLTextAreaElement) return el.value || undefined;
  return undefined;
}

function insertChar(el: Element | null, ch: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + ch + el.value.slice(end);
    const pos = start + ch.length;
    el.setSelectionRange?.(pos, pos);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    document.execCommand("insertText", false, ch);
  }
}

function dispatchKey(el: Element | null, type: "keydown" | "keyup", key: string): void {
  const target = el ?? document.activeElement ?? document.body;
  target?.dispatchEvent(
    new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true }),
  );
}

function buttonIndex(button: MouseButton): number {
  return button === "right" ? 2 : button === "middle" ? 1 : 0;
}

function buttonsMask(button: number): number {
  return button === 2 ? 2 : button === 1 ? 4 : 1;
}

function fireMouse(target: Element, type: string, x: number, y: number, button: number, detail = 0): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button,
      buttons: type === "mousedown" ? buttonsMask(button) : 0,
      detail,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    }),
  );
}

function firePointer(target: Element, type: string, x: number, y: number, button: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: type === "pointermove" ? -1 : button,
      buttons: type === "pointerdown" ? buttonsMask(button) : 0,
      pointerType: "mouse",
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    }),
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
