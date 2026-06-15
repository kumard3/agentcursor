export const DEFAULT_WS_PORT = 8787;
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
    }
  | { kind: "scroll"; dx: number; dy: number; steps: number; mode: DeliveryMode }
  | { kind: "navigate"; url: string }
  | { kind: "getUrl" }
  | { kind: "waitFor"; ref?: string; text?: string; timeoutMs: number };

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
