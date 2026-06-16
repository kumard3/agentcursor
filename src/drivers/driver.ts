import type {
  CursorSample,
  DeliveryMode,
  MouseButton,
  PageSnapshot,
  Point,
  Rect,
} from "../protocol";

export interface ClickArgs {
  samples: CursorSample[];
  target: Point;
  button: MouseButton;
  dblclick: boolean;
  preClickDwellMs: number;
  pressMs: number;
  mode: DeliveryMode;
}

export interface TypeArgs {
  text: string;
  ref?: string;
  perKeyMinMs: number;
  perKeyMaxMs: number;
  mode: DeliveryMode;
}

export interface ScrollArgs {
  dx: number;
  dy: number;
  steps: number;
  mode: DeliveryMode;
}

export interface WaitArgs {
  ref?: string;
  text?: string;
  timeoutMs: number;
  condition?: "exists" | "visible" | "text";
}

/**
 * Low-level browser primitives. The ActionService depends on this interface,
 * not on any concrete transport, so phase 2's OS-cursor driver drops in here
 * without touching the engine or the MCP layer.
 */
export interface BrowserDriver {
  snapshot(maxElements: number, includeText: boolean): Promise<PageSnapshot>;
  cursorState(): Promise<Point>;
  move(samples: CursorSample[], mode: DeliveryMode): Promise<void>;
  click(args: ClickArgs): Promise<void>;
  type(args: TypeArgs): Promise<void>;
  scroll(args: ScrollArgs): Promise<void>;
  navigate(url: string): Promise<void>;
  getUrl(): Promise<string>;
  waitFor(args: WaitArgs): Promise<boolean>;
  screenshot(format?: "png" | "jpeg"): Promise<string>;
  hover(opts: { ref?: string; x?: number; y?: number; stealth?: boolean }): Promise<void>;
  ensureVisible(ref?: string, point?: Point): Promise<Rect | null>;
  drag(args: { samples: CursorSample[]; target: Point; button: MouseButton; mode: DeliveryMode }): Promise<void>;
}
