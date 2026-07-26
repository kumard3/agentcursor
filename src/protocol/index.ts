export const DEFAULT_WS_PORT = 8930;
export const PROTOCOL_VERSION = 1;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single cursor position with a millisecond offset from the move start. */
export interface CursorSample {
  x: number;
  y: number;
  t: number;
}

export interface PageElement {
  ref: string;
  tag: string;
  role: string;
  name: string;
  rect: Rect;
  editable: boolean;
  value?: string;
  visible?: boolean;
  inViewport?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
  elements: PageElement[];
  text: string;
}

export interface WindowGeometry {
  screenX: number;
  screenY: number;
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  devicePixelRatio: number;
}

export type DeliveryMode = "content" | "debugger";
export type MouseButton = "left" | "right" | "middle";

/**
 * A single typing operation. `key` inserts a character after `delayMs`; `back`
 * deletes one character (used to render a typo correction). Applying a whole
 * schedule left to right yields the intended final text.
 */
export type KeyOp =
  | { t: "key"; ch: string; delayMs: number }
  | { t: "back"; delayMs: number };

/** A serializable, Playwright-style locator query. Resolved in the content script. */
export type LocatorStep =
  | { kind: "css"; value: string }
  | { kind: "role"; value: string; name?: string; exact?: boolean }
  | { kind: "text"; value: string; exact?: boolean }
  | { kind: "label"; value: string; exact?: boolean }
  | { kind: "placeholder"; value: string; exact?: boolean }
  | { kind: "testid"; value: string }
  | { kind: "filter"; hasText: string }
  | { kind: "nth"; index: number };

export type LocatorSpec = LocatorStep[];

export interface LocatorMatch {
  handle: string;
  rect: Rect;
  count: number;
  visible: boolean;
  text: string;
}

export type Command =
  | { kind: "snapshot"; maxElements: number; includeText: boolean }
  | { kind: "cursorState" }
  | { kind: "windowGeometry" }
  | { kind: "replayMove"; samples: CursorSample[]; mode: DeliveryMode }
  | {
      kind: "replayClick";
      samples: CursorSample[];
      target: Point;
      button: MouseButton;
      dblclick: boolean;
      preClickDwellMs: number;
      pressMs: number;
      mode: DeliveryMode;
    }
  | {
      kind: "type";
      text: string;
      ref?: string;
      perKeyMinMs: number;
      perKeyMaxMs: number;
      mode: DeliveryMode;
      replace?: boolean;
      /** Persona keystroke schedule (bursts, boundary pauses, typo corrections).
       * When present, content/OS drivers render it; stealth ignores it and inserts `text`. */
      schedule?: KeyOp[];
    }
  | { kind: "scroll"; dx: number; dy: number; steps: number; mode: DeliveryMode }
  | { kind: "navigate"; url: string }
  | { kind: "getUrl" }
  | { kind: "screenshot"; format?: "png" | "jpeg" }
  | { kind: "hover"; ref?: string; x?: number; y?: number; mode?: DeliveryMode }
  | { kind: "ensureVisible"; ref?: string; point?: Point }
  | { kind: "showCursorPath"; samples: CursorSample[] }
  | {
      kind: "drag";
      samples: CursorSample[];
      target: Point;
      button: MouseButton;
      mode: DeliveryMode;
    }
  | { kind: "waitFor"; ref?: string; text?: string; timeoutMs: number; condition?: "exists" | "visible" | "text" }
  | { kind: "pressKey"; key: string; mode: DeliveryMode }
  | { kind: "resolveLocator"; spec: LocatorSpec; timeoutMs: number; scrollIntoView?: boolean };

export interface CommandEnvelope {
  v: number;
  id: string;
  command: Command;
}

export type CommandResult =
  | { id: string; ok: true; data?: unknown }
  | { id: string; ok: false; error: string };

export function isCommandEnvelope(value: unknown): value is CommandEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "command" in value
  );
}
