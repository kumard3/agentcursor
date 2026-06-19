interface Point {
    x: number;
    y: number;
}
interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** A single cursor position with a millisecond offset from the move start. */
interface CursorSample {
    x: number;
    y: number;
    t: number;
}
interface PageElement {
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
interface PageSnapshot {
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
type DeliveryMode = "content" | "debugger";
type MouseButton = "left" | "right" | "middle";
/** A serializable, Playwright-style locator query. Resolved in the content script. */
type LocatorStep = {
    kind: "css";
    value: string;
} | {
    kind: "role";
    value: string;
    name?: string;
    exact?: boolean;
} | {
    kind: "text";
    value: string;
    exact?: boolean;
} | {
    kind: "label";
    value: string;
    exact?: boolean;
} | {
    kind: "placeholder";
    value: string;
    exact?: boolean;
} | {
    kind: "testid";
    value: string;
} | {
    kind: "filter";
    hasText: string;
} | {
    kind: "nth";
    index: number;
};
type LocatorSpec = LocatorStep[];
interface LocatorMatch {
    handle: string;
    rect: Rect;
    count: number;
    visible: boolean;
    text: string;
}
type Command = {
    kind: "snapshot";
    maxElements: number;
    includeText: boolean;
} | {
    kind: "cursorState";
} | {
    kind: "windowGeometry";
} | {
    kind: "replayMove";
    samples: CursorSample[];
    mode: DeliveryMode;
} | {
    kind: "replayClick";
    samples: CursorSample[];
    target: Point;
    button: MouseButton;
    dblclick: boolean;
    preClickDwellMs: number;
    pressMs: number;
    mode: DeliveryMode;
} | {
    kind: "type";
    text: string;
    ref?: string;
    perKeyMinMs: number;
    perKeyMaxMs: number;
    mode: DeliveryMode;
    replace?: boolean;
} | {
    kind: "scroll";
    dx: number;
    dy: number;
    steps: number;
    mode: DeliveryMode;
} | {
    kind: "navigate";
    url: string;
} | {
    kind: "getUrl";
} | {
    kind: "screenshot";
    format?: "png" | "jpeg";
} | {
    kind: "hover";
    ref?: string;
    x?: number;
    y?: number;
    mode?: DeliveryMode;
} | {
    kind: "ensureVisible";
    ref?: string;
    point?: Point;
} | {
    kind: "showCursorPath";
    samples: CursorSample[];
} | {
    kind: "drag";
    samples: CursorSample[];
    target: Point;
    button: MouseButton;
    mode: DeliveryMode;
} | {
    kind: "waitFor";
    ref?: string;
    text?: string;
    timeoutMs: number;
    condition?: "exists" | "visible" | "text";
} | {
    kind: "pressKey";
    key: string;
    mode: DeliveryMode;
} | {
    kind: "resolveLocator";
    spec: LocatorSpec;
    timeoutMs: number;
    scrollIntoView?: boolean;
};

interface ClickArgs {
    samples: CursorSample[];
    target: Point;
    button: MouseButton;
    dblclick: boolean;
    preClickDwellMs: number;
    pressMs: number;
    mode: DeliveryMode;
}
interface TypeArgs {
    text: string;
    ref?: string;
    perKeyMinMs: number;
    perKeyMaxMs: number;
    mode: DeliveryMode;
    replace?: boolean;
}
interface ScrollArgs {
    dx: number;
    dy: number;
    steps: number;
    mode: DeliveryMode;
}
interface WaitArgs {
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
interface BrowserDriver {
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
    hover(opts: {
        ref?: string;
        x?: number;
        y?: number;
        stealth?: boolean;
    }): Promise<void>;
    ensureVisible(ref?: string, point?: Point): Promise<Rect | null>;
    drag(args: {
        samples: CursorSample[];
        target: Point;
        button: MouseButton;
        mode: DeliveryMode;
    }): Promise<void>;
    pressKey(key: string, mode: DeliveryMode): Promise<void>;
    resolveLocator(spec: LocatorSpec, opts: {
        timeoutMs: number;
        scrollIntoView?: boolean;
    }): Promise<LocatorMatch>;
}

interface TargetOpts {
    ref?: string;
    x?: number;
    y?: number;
    rect?: Rect;
}
/**
 * High-level human actions. Owns the cached snapshot + last cursor position,
 * turns a target into a human path via the engine, and hands samples to the
 * driver. Knows nothing about the transport (depends on BrowserDriver).
 */
declare class ActionService {
    private readonly driver;
    private snapshot;
    private lastPos;
    constructor(driver: BrowserDriver);
    readPage(maxElements?: number, includeText?: boolean): Promise<PageSnapshot>;
    moveTo(opts: TargetOpts & {
        stealth?: boolean;
    }): Promise<Point>;
    click(opts: TargetOpts & {
        button?: MouseButton;
        double?: boolean;
        stealth?: boolean;
    }): Promise<Point>;
    type(opts: {
        text: string;
        ref?: string;
        rect?: Rect;
        replace?: boolean;
        stealth?: boolean;
    }): Promise<void>;
    resolveLocator(spec: LocatorSpec, opts?: {
        timeoutMs?: number;
        scrollIntoView?: boolean;
    }): Promise<LocatorMatch>;
    scroll(opts: {
        dy: number;
        dx?: number;
        stealth?: boolean;
    }): Promise<void>;
    navigate(url: string): Promise<void>;
    getUrl(): Promise<string>;
    waitFor(opts: {
        ref?: string;
        text?: string;
        timeoutMs?: number;
        condition?: "exists" | "visible" | "text";
    }): Promise<boolean>;
    screenshot(format?: "png" | "jpeg"): Promise<string>;
    hover(opts?: {
        ref?: string;
        x?: number;
        y?: number;
        stealth?: boolean;
    }): Promise<void>;
    drag(from: TargetOpts, to: TargetOpts, button?: MouseButton, stealth?: boolean): Promise<void>;
    /** Identification: rank on-screen elements by how well their text/name matches a query. */
    find(text: string, opts?: {
        maxResults?: number;
    }): Promise<PageElement[]>;
    /** Identification + interaction: find the best text match, then human-click it (re-reading if needed). */
    clickText(text: string, opts?: {
        stealth?: boolean;
        nth?: number;
        button?: MouseButton;
        double?: boolean;
    }): Promise<{
        matched: PageElement;
        point: Point;
    }>;
    pressKey(key: string, stealth?: boolean): Promise<void>;
    private ensureStart;
    private ensureFresh;
    private resolveTarget;
    private findElement;
}

interface LocatorContext {
    action: ActionService;
    stealth: boolean;
}
interface ByOptions {
    exact?: boolean;
}
interface ByRoleOptions {
    name?: string;
    exact?: boolean;
}
/**
 * A lazy, Playwright-shaped handle to an element. Chaining and filtering build
 * up a serializable spec; an action resolves the spec to a rect and then drives
 * the human cursor through ActionService.
 */
declare class Locator {
    private readonly ctx;
    private readonly spec;
    constructor(ctx: LocatorContext, spec: LocatorSpec);
    locator(css: string): Locator;
    getByRole(role: string, opts?: ByRoleOptions): Locator;
    getByText(text: string, opts?: ByOptions): Locator;
    getByLabel(text: string, opts?: ByOptions): Locator;
    getByPlaceholder(text: string, opts?: ByOptions): Locator;
    getByTestId(id: string): Locator;
    filter(opts: {
        hasText: string;
    }): Locator;
    nth(index: number): Locator;
    first(): Locator;
    last(): Locator;
    click(opts?: {
        button?: MouseButton;
        double?: boolean;
        stealth?: boolean;
    }): Promise<Locator>;
    dblclick(opts?: {
        button?: MouseButton;
        stealth?: boolean;
    }): Promise<Locator>;
    hover(opts?: {
        stealth?: boolean;
    }): Promise<Locator>;
    type(text: string, opts?: {
        stealth?: boolean;
    }): Promise<Locator>;
    fill(text: string, opts?: {
        stealth?: boolean;
    }): Promise<Locator>;
    press(key: string, opts?: {
        stealth?: boolean;
    }): Promise<Locator>;
    dragTo(target: Locator, opts?: {
        stealth?: boolean;
    }): Promise<Locator>;
    scrollIntoView(): Promise<Locator>;
    boundingBox(): Promise<Rect | null>;
    textContent(): Promise<string | null>;
    isVisible(): Promise<boolean>;
    count(): Promise<number>;
    waitFor(opts?: {
        state?: "visible" | "attached";
        timeout?: number;
    }): Promise<Locator>;
    private step;
    private resolve;
    private require;
}

interface ConnectOptions {
    /** WebSocket port the extension connects to (default 8930). */
    port?: number;
    /** Deliver events via CDP (isTrusted=true) instead of synthetic DOM events. */
    stealth?: boolean;
    /** How long to wait for the browser/extension to connect (default 15s). */
    timeoutMs?: number;
}
/**
 * Programmatic entry point. Playwright-shaped locator API where every action is
 * driven by the human-cursor engine. Lifecycles: connect() attaches to a running
 * Chrome with the extension loaded; os() drives the real OS cursor via nut-js.
 */
declare class AgentCursor {
    private readonly action;
    private readonly transport;
    private readonly opts;
    private constructor();
    static connect(options?: ConnectOptions): Promise<AgentCursor>;
    static os(options?: ConnectOptions): Promise<AgentCursor>;
    private static start;
    /** Escape hatch to the lower-level action service (move_to by coords, find, clickText, etc.). */
    get actions(): ActionService;
    locator(css: string): Locator;
    getByRole(role: string, opts?: ByRoleOptions): Locator;
    getByText(text: string, opts?: ByOptions): Locator;
    getByLabel(text: string, opts?: ByOptions): Locator;
    getByPlaceholder(text: string, opts?: ByOptions): Locator;
    getByTestId(id: string): Locator;
    navigate(url: string): Promise<AgentCursor>;
    goto(url: string): Promise<AgentCursor>;
    url(): Promise<string>;
    scroll(opts: {
        dy: number;
        dx?: number;
        stealth?: boolean;
    }): Promise<AgentCursor>;
    waitForText(text: string, opts?: {
        timeout?: number;
    }): Promise<boolean>;
    screenshot(opts?: {
        format?: "png" | "jpeg";
        path?: string;
    }): Promise<string>;
    close(): Promise<void>;
    private ctx;
    private root;
}

interface Rng {
    /** uniform in [0, 1) */
    next(): number;
    range(min: number, max: number): number;
    int(min: number, max: number): number;
    gaussian(mean?: number, std?: number): number;
    /** right-skewed value in [min, max]; higher power = stronger skew toward min */
    skewed(min: number, max: number, power?: number): number;
    bool(p: number): boolean;
}
/**
 * Seedable mulberry32 PRNG. A seed exists only so tests can assert
 * determinism; production calls omit it and draw fresh entropy each move.
 */
declare function createRng(seed?: number): Rng;

interface MoveOptions {
    rng?: Rng;
    /** approximate target size, feeds Fitts duration; default 24 */
    targetWidth?: number;
    /** Gaussian jitter amplitude in px; default 1.4 */
    jitter?: number;
    /** allow overshoot-and-correct on long moves; default true */
    overshoot?: boolean;
}
declare function generateMove(from: Point, to: Point, options?: MoveOptions): CursorSample[];
/** A point inside the rect, offset from dead-center (humans miss the middle). */
declare function offCenterPoint(rect: Rect, rng?: Rng): Point;
declare function sampleDwellMs(rng?: Rng): number;
declare function samplePressMs(rng?: Rng): number;
declare function sampleKeyDelayMs(rng?: Rng): {
    min: number;
    max: number;
};

/** Hosts a localhost WebSocket and turns commands into awaited request/reply. */
declare class ExtensionTransport {
    private readonly wss;
    private socket;
    private readonly pending;
    constructor(port?: number);
    get connected(): boolean;
    send(command: Command, timeoutMs?: number): Promise<unknown>;
    private onMessage;
    close(): void;
}

declare class ExtensionDriver implements BrowserDriver {
    private readonly transport;
    constructor(transport: ExtensionTransport);
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
    hover(opts: {
        ref?: string;
        x?: number;
        y?: number;
        stealth?: boolean;
    }): Promise<void>;
    ensureVisible(ref?: string, point?: Point): Promise<Rect | null>;
    drag(args: {
        samples: CursorSample[];
        target: Point;
        button: MouseButton;
        mode: DeliveryMode;
    }): Promise<void>;
    pressKey(key: string, mode: DeliveryMode): Promise<void>;
    resolveLocator(spec: LocatorSpec, opts: {
        timeoutMs: number;
        scrollIntoView?: boolean;
    }): Promise<LocatorMatch>;
}

/**
 * Phase 2: moves the real macOS system cursor (genuine OS events, isTrusted
 * and indistinguishable). Senses the page through the extension; acts through
 * nut-js. Implements the same BrowserDriver interface as the extension driver.
 */
declare class OsCursorDriver implements BrowserDriver {
    private readonly transport;
    private nut;
    private geom;
    constructor(transport: ExtensionTransport);
    snapshot(maxElements: number, includeText: boolean): Promise<PageSnapshot>;
    getUrl(): Promise<string>;
    navigate(url: string): Promise<void>;
    waitFor(args: WaitArgs): Promise<boolean>;
    screenshot(format?: "png" | "jpeg"): Promise<string>;
    hover(opts: {
        ref?: string;
        x?: number;
        y?: number;
        stealth?: boolean;
    }): Promise<void>;
    ensureVisible(ref?: string, point?: Point): Promise<Rect | null>;
    drag(args: {
        samples: CursorSample[];
        target: Point;
        button: MouseButton;
        mode: DeliveryMode;
    }): Promise<void>;
    pressKey(key: string, mode: DeliveryMode): Promise<void>;
    resolveLocator(spec: LocatorSpec, opts: {
        timeoutMs: number;
        scrollIntoView?: boolean;
    }): Promise<LocatorMatch>;
    cursorState(): Promise<Point>;
    move(samples: CursorSample[], _mode: DeliveryMode): Promise<void>;
    click(args: ClickArgs): Promise<void>;
    type(args: TypeArgs): Promise<void>;
    scroll(args: ScrollArgs): Promise<void>;
    private ensureNut;
    private geometry;
}

export { ActionService, AgentCursor, type BrowserDriver, type ByOptions, type ByRoleOptions, type ConnectOptions, type CursorSample, type DeliveryMode, ExtensionDriver, ExtensionTransport, Locator, type LocatorContext, type LocatorMatch, type LocatorSpec, type LocatorStep, type MouseButton, OsCursorDriver, type PageElement, type PageSnapshot, type Point, type Rect, createRng, generateMove, offCenterPoint, sampleDwellMs, sampleKeyDelayMs, samplePressMs };
