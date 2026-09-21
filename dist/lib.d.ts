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
/**
 * A single typing operation. `key` inserts a character after `delayMs`; `back`
 * deletes one character (used to render a typo correction). Applying a whole
 * schedule left to right yields the intended final text.
 */
type KeyOp = {
    t: "key";
    ch: string;
    delayMs: number;
} | {
    t: "back";
    delayMs: number;
};
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
    /** Persona keystroke schedule (bursts, boundary pauses, typo corrections).
     * When present, content/OS drivers render it; stealth ignores it and inserts `text`. */
    schedule?: KeyOp[];
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
} | {
    kind: "evaluate";
    expression: string;
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
    /** persona keystroke schedule; content/OS drivers render it, stealth ignores it */
    schedule?: KeyOp[];
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
    evaluate(expression: string): Promise<unknown>;
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
    /** allow overshoot-and-correct on long moves; default true */
    overshoot?: boolean;
    /** persona: move-duration divisor; default 1 */
    speedFactor?: number;
    /** persona: Bézier bow scale; default 1 */
    curviness?: number;
    /** persona: Gaussian jitter amplitude in px; default 1.4 */
    jitterPx?: number;
    /** persona: overshoot chance on a long move; default 0.5 */
    overshootProb?: number;
    /** persona: overshoot distance as fraction of travel; default 0.12 */
    overshootMag?: number;
    /** persona: -1/+1 curvature side bias; 0 = unbiased (default) */
    handedness?: number;
}
declare function generateMove(from: Point, to: Point, options?: MoveOptions): CursorSample[];
/** A point inside the rect, offset from dead-center (humans miss the middle).
 * `precision` is the spread as a fraction of the target; smaller = tighter. */
declare function offCenterPoint(rect: Rect, rng?: Rng, precision?: number): Point;
declare function sampleDwellMs(rng?: Rng, dwellScale?: number): number;
declare function samplePressMs(rng?: Rng, pressScale?: number): number;
declare function sampleKeyDelayMs(rng?: Rng): {
    min: number;
    max: number;
};

/**
 * One person's stable motor + typing signature. Sampled once from the seed;
 * every action reads these so a whole session reads as the same person.
 */
interface PersonaTraits {
    /** move-duration divisor: >1 faster, <1 slower */
    speedFactor: number;
    /** Bézier bow scale */
    curviness: number;
    /** hand-tremor amplitude, px */
    jitterPx: number;
    /** chance of an overshoot-and-correct on a long move */
    overshootProb: number;
    /** overshoot distance as a fraction of travel */
    overshootMag: number;
    /** off-center click spread as a fraction of the target */
    precision: number;
    /** pre-click dwell multiplier */
    dwellScale: number;
    /** button-hold multiplier */
    pressScale: number;
    /** typing speed, words per minute */
    wpm: number;
    /** per-character typo probability */
    errorRate: number;
    /** base reaction delay, ms */
    reactionMs: number;
    /** think-time multiplier */
    thinkScale: number;
    /** reading pause per visible character, ms */
    readMsPerChar: number;
    /** curvature side bias, -1 or +1 */
    handedness: number;
}
interface PersonaInfo {
    seed: number;
    traits: PersonaTraits;
    actionCount: number;
    fatigue: number;
}
interface PersonaOptions {
    seed?: number;
    /** injectable clock (ms) so tests can drive fatigue deterministically */
    now?: () => number;
}
declare class Persona {
    readonly seed: number;
    readonly rng: Rng;
    readonly base: PersonaTraits;
    private actions;
    private readonly startMs;
    private readonly clock;
    constructor(opts?: PersonaOptions);
    /** Advance fatigue bookkeeping; call once per action. */
    tick(): void;
    /** 0..FATIGUE_MAX, grows with elapsed session time. */
    get fatigue(): number;
    /** Traits after fatigue drift (slower, shakier, more hesitant over time). */
    traits(): PersonaTraits;
    info(): PersonaInfo;
    /** Cognitive delay before an action; `distancePx` is the cursor travel. */
    thinkTimeMs(distancePx?: number): number;
    /** Pause to "read" `chars` of freshly surfaced text, capped. */
    readPauseMs(chars: number): number;
    moveOptions(targetWidth: number): MoveOptions;
    keySchedule(text: string): KeyOp[];
}
declare function createPersona(seed?: number, opts?: Omit<PersonaOptions, "seed">): Persona;

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
    private readonly persona;
    constructor(driver: BrowserDriver, persona?: Persona);
    /** The active session persona (seed + traits), for status/inspection. */
    personaInfo(): PersonaInfo;
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
    evaluate(fn: string, args?: unknown[]): Promise<unknown>;
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
    /** Cognitive delay before an action. */
    private think;
    /** A small settle move while waiting, the way a hand never sits perfectly still. */
    private idleDrift;
    private findElement;
}

interface LaunchOptions {
    /** Chrome or Chromium binary. Defaults to AGENTCURSOR_CHROME, then the usual install paths.
     * Point this at Chrome for Testing, Brave, Edge, or BrowserOS to drive that browser. */
    executablePath?: string;
    /** Run without a window (CI, or a real profile in the background). The cursor is still drawn. */
    headless?: boolean;
    /** Drive an existing profile directory instead of a throwaway copy: real cookies/logins,
     * left intact on close. The browser must NOT already be running on this dir (profile lock). */
    userDataDir?: string;
    /** Extra Chrome flags, e.g. ["--window-size=900,800", "--window-position=0,0"]. */
    args?: string[];
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
    textContent(opts?: {
        timeout?: number;
    }): Promise<string | null>;
    isVisible(): Promise<boolean>;
    count(): Promise<number>;
    waitFor(opts?: {
        state?: "visible" | "attached";
        timeout?: number;
    }): Promise<Locator>;
    toString(): string;
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
    /** Persona seed. Same seed reproduces the same "person" (motion + typing); omit for a fresh one. */
    seed?: number;
}
/**
 * Programmatic entry point. Playwright-shaped locator API where every action is
 * driven by the human-cursor engine. Lifecycles: launch() starts a private
 * Chrome with its own cursor (e2e tests; run several side by side); connect()
 * attaches to a running Chrome with the extension loaded; os() drives the real
 * OS cursor via nut-js.
 */
declare class AgentCursor {
    private readonly action;
    private readonly transport;
    private readonly opts;
    private readonly dispose?;
    private constructor();
    static launch(options?: Omit<ConnectOptions, "port"> & LaunchOptions): Promise<AgentCursor>;
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
    evaluate<T = unknown>(fn: string | ((...a: any[]) => any), ...args: unknown[]): Promise<T>;
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

interface AxApp {
    name: string;
    pid: number;
    bundleId: string;
    active?: boolean;
}
interface AxWindow {
    title: string;
    x: number;
    y: number;
    w: number;
    h: number;
}
interface AxPermissions {
    accessibility: boolean;
    screenRecording: boolean;
}

interface DesktopElement {
    ref: string;
    role: string;
    name: string;
    value?: string;
    rect: Rect;
    enabled?: boolean;
    focused?: boolean;
}
interface DesktopView {
    app: AxApp;
    window: AxWindow;
    elements: DesktopElement[];
    truncated: boolean;
}
interface DesktopTarget {
    ref?: string;
    text?: string;
    x?: number;
    y?: number;
    app?: string;
}
interface Screenshot {
    data: string;
    mimeType: string;
    note: string;
}
declare class DesktopService {
    private readonly persona;
    private view;
    private currentPid;
    constructor(persona: Persona);
    permissions(): Promise<AxPermissions>;
    requestPermission(kind: "accessibility" | "screen"): Promise<Partial<AxPermissions>>;
    apps(): Promise<AxApp[]>;
    open(app: string): Promise<AxApp>;
    read(opts?: {
        app?: string;
        max?: number;
    }): Promise<DesktopView>;
    find(text: string, opts?: {
        app?: string;
        maxResults?: number;
    }): Promise<DesktopElement[]>;
    click(t: DesktopTarget & {
        button?: MouseButton;
        double?: boolean;
    }): Promise<string>;
    move(t: DesktopTarget): Promise<string>;
    type(opts: DesktopTarget & {
        value: string;
        clear?: boolean;
        submit?: boolean;
    }): Promise<void>;
    key(combo: string): Promise<void>;
    scroll(opts: DesktopTarget & {
        dy: number;
        dx?: number;
    }): Promise<void>;
    screenshot(opts?: {
        app?: string;
        ref?: string;
        maxWidth?: number;
    }): Promise<Screenshot>;
    wiggle(): Promise<void>;
    private element;
    private resolve;
    private moveHuman;
    private front;
}

interface DesktopOptions {
    /** Persona seed. Same seed reproduces the same motion and typing. */
    seed?: number;
}
/** A [dN] ref, or the visible text/label of a control. */
type DesktopQuery = string | {
    ref?: string;
    text?: string;
    x?: number;
    y?: number;
    app?: string;
};
/**
 * Computer use: drive any Mac app with the real cursor, reading the window as
 * text from the accessibility tree instead of screenshots. Same engine, persona
 * and reads as the desktop_* MCP tools.
 */
declare class Desktop {
    private readonly service;
    private constructor();
    static open(app?: string, options?: DesktopOptions): Promise<Desktop>;
    /** Escape hatch to the lower-level service (same object the MCP tools use). */
    get actions(): DesktopService;
    apps(): Promise<AxApp[]>;
    permissions(): Promise<AxPermissions>;
    activate(app: string): Promise<AxApp>;
    /** The window as compact text with [dN] refs: far fewer tokens than a screenshot. */
    read(opts?: {
        app?: string;
        max?: number;
    }): Promise<string>;
    /** Structured form of read(), when you want to assert on elements yourself. */
    view(opts?: {
        app?: string;
        max?: number;
    }): Promise<DesktopView>;
    /** Only the elements matching a label: a handful of tokens instead of a whole window. */
    find(text: string, opts?: {
        app?: string;
        maxResults?: number;
    }): Promise<string>;
    elements(text: string, opts?: {
        app?: string;
        maxResults?: number;
    }): Promise<DesktopElement[]>;
    click(q: DesktopQuery, opts?: {
        button?: MouseButton;
        double?: boolean;
    }): Promise<string>;
    dblclick(q: DesktopQuery): Promise<string>;
    move(q: DesktopQuery): Promise<string>;
    type(value: string, opts?: {
        into?: DesktopQuery;
        clear?: boolean;
        submit?: boolean;
    }): Promise<void>;
    key(combo: string): Promise<void>;
    scroll(opts: {
        dy: number;
        dx?: number;
        over?: DesktopQuery;
    }): Promise<void>;
    /** Window screenshot, downscaled. Use when the text read is not enough. */
    screenshot(opts?: {
        app?: string;
        ref?: string;
        maxWidth?: number;
        path?: string;
    }): Promise<string>;
    /** Waits for text to appear in the window. Returns false on timeout. */
    waitForText(text: string, opts?: {
        app?: string;
        timeout?: number;
    }): Promise<boolean>;
}

interface Expectation {
    readonly not: Expectation;
    toBeVisible(): Promise<void>;
    toBeHidden(): Promise<void>;
    toHaveText(expected: string | RegExp): Promise<void>;
    toContainText(expected: string): Promise<void>;
    toHaveCount(expected: number): Promise<void>;
    toHaveURL(expected: string | RegExp): Promise<void>;
}
/**
 * Playwright-style web-first assertions: each matcher re-checks the live page
 * until it passes or `timeout` (default 5s) runs out, so tests don't need sleeps.
 */
declare function expect(target: Locator | AgentCursor, opts?: {
    timeout?: number;
}): Expectation;

/** Traits the typing scheduler reads (subset of PersonaTraits). */
interface TypingTraits {
    wpm: number;
    errorRate: number;
    reactionMs: number;
}
/**
 * Turn text into a human keystroke schedule: burst timing, longer pauses at word
 * and sentence boundaries, a slower first key (reaction), and occasional typos
 * that are immediately backspaced and corrected. Invariant: flattenSchedule of
 * the result equals `text`.
 */
declare function buildTypingSchedule(text: string, rng: Rng, traits: TypingTraits): KeyOp[];
/** Net text after applying every insert/backspace — what the field ends up with. */
declare function flattenSchedule(ops: KeyOp[]): string;
/**
 * Reduce a schedule to only the keystrokes that survive its backspaces, each
 * carrying a delay. For drivers that can't render a live backspace (nut-js OS
 * typing), so they still get persona timing on the final text without typos.
 */
declare function scheduleToKeystrokes(ops: KeyOp[]): Array<{
    ch: string;
    delayMs: number;
}>;

/** Hosts a localhost WebSocket and turns commands into awaited request/reply. */
declare class ExtensionTransport {
    private readonly wss;
    private socket;
    private readonly pending;
    constructor(port?: number);
    /** Resolves to the bound port; pass port 0 to the constructor for a free one. */
    listening(): Promise<number>;
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
    evaluate(expression: string): Promise<unknown>;
}

/**
 * Phase 2: moves the real macOS system cursor (genuine OS events, isTrusted
 * and indistinguishable). Senses the page through the extension; acts through
 * nut-js. Implements the same BrowserDriver interface as the extension driver.
 */
declare class OsCursorDriver implements BrowserDriver {
    private readonly transport;
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
    evaluate(expression: string): Promise<unknown>;
    cursorState(): Promise<Point>;
    move(samples: CursorSample[], _mode: DeliveryMode): Promise<void>;
    click(args: ClickArgs): Promise<void>;
    type(args: TypeArgs): Promise<void>;
    scroll(args: ScrollArgs): Promise<void>;
    private geometry;
}

export { ActionService, AgentCursor, type BrowserDriver, type ByOptions, type ByRoleOptions, type ConnectOptions, type CursorSample, type DeliveryMode, Desktop, type DesktopOptions, type DesktopQuery, DesktopService, type Expectation, ExtensionDriver, ExtensionTransport, type KeyOp, type LaunchOptions, Locator, type LocatorContext, type LocatorMatch, type LocatorSpec, type LocatorStep, type MouseButton, OsCursorDriver, type PageElement, type PageSnapshot, Persona, type PersonaInfo, type PersonaOptions, type PersonaTraits, type Point, type Rect, buildTypingSchedule, createPersona, createRng, expect, flattenSchedule, generateMove, offCenterPoint, sampleDwellMs, sampleKeyDelayMs, samplePressMs, scheduleToKeystrokes };
