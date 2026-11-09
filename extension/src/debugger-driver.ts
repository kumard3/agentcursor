import { PROTOCOL_VERSION, type Command, type CursorSample, type MouseButton, type Point } from "../../src/protocol";
import { rand, sleep, sleepUntil } from "./timing";

function cdpButtonsMask(button: MouseButton): number {
  return button === "right" ? 2 : button === "middle" ? 4 : 1;
}

const CDP_KEYS: Record<string, { code: string; vk: number }> = {
  Enter: { code: "Enter", vk: 13 },
  Escape: { code: "Escape", vk: 27 },
  Tab: { code: "Tab", vk: 9 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  " ": { code: "Space", vk: 32 },
};

/**
 * Delivers input via chrome.debugger / CDP so events arrive with
 * isTrusted=true. Shows the "debugging this browser" banner while attached.
 */
export class DebuggerDriver {
  // Refcounted: a recording holds a lease for its whole life, so the
  // attach/detach around each input command cannot pull the session out from
  // under it.
  private readonly leases = new Map<number, number>();
  private readonly screencasts = new Map<
    number,
    (source: chrome.debugger.Debuggee, method: string, params?: object) => void
  >();

  async handle(tabId: number, cmd: Command): Promise<unknown> {
    await this.attach(tabId);
    try {
      switch (cmd.kind) {
        case "replayMove":
          await this.move(tabId, cmd.samples);
          return null;
        case "replayClick":
          await this.move(tabId, cmd.samples);
          await sleep(cmd.preClickDwellMs);
          await this.click(tabId, cmd.target, cmd.button, cmd.dblclick, cmd.pressMs);
          return null;
        case "type":
          await this.type(tabId, cmd.text, cmd.perKeyMinMs, cmd.perKeyMaxMs);
          return null;
        case "scroll":
          await this.scroll(tabId, cmd.dx, cmd.dy, cmd.steps);
          return null;
        case "drag":
          await this.drag(tabId, cmd.samples, cmd.target, cmd.button);
          return null;
        case "pressKey":
          await this.pressKey(tabId, cmd.key);
          return null;
        default:
          throw new Error(`debugger driver cannot handle '${cmd.kind}'`);
      }
    } finally {
      await this.detach(tabId);
    }
  }

  async evaluate(tabId: number, expression: string): Promise<unknown> {
    await this.attach(tabId);
    try {
      const res = (await this.send(tabId, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })) as {
        result?: { value?: unknown; description?: string };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      if (res.exceptionDetails) {
        const ex = res.exceptionDetails;
        throw new Error(ex.exception?.description ?? ex.text ?? "evaluate failed");
      }
      return res.result?.value ?? null;
    } finally {
      await this.detach(tabId);
    }
  }

  private async attach(tabId: number): Promise<void> {
    const held = this.leases.get(tabId) ?? 0;
    if (held === 0) await chrome.debugger.attach({ tabId }, "1.3");
    this.leases.set(tabId, held + 1);
  }

  private async detach(tabId: number): Promise<void> {
    const held = this.leases.get(tabId) ?? 0;
    if (held === 0) return;
    if (held > 1) {
      this.leases.set(tabId, held - 1);
      return;
    }
    this.leases.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* tab may already be gone */
    }
  }

  /**
   * Streams what the tab paints, as CDP screencast frames. Each frame is
   * handed to onFrame and acknowledged, which is what keeps the next one
   * coming. The visible cursor is a DOM overlay, so it is in the frames.
   */
  async startScreencast(
    tabId: number,
    options: {
      format?: "jpeg" | "png";
      quality?: number;
      maxWidth?: number;
      maxHeight?: number;
      everyNthFrame?: number;
    },
    onFrame: (frame: { data: string; metadata?: Record<string, unknown> }) => void,
  ): Promise<void> {
    if (this.screencasts.has(tabId)) return;
    await this.attach(tabId);

    const listener = (
      source: chrome.debugger.Debuggee,
      method: string,
      params?: object,
    ): void => {
      if (source.tabId !== tabId || method !== "Page.screencastFrame") return;
      const frame = params as {
        data: string;
        sessionId: number;
        metadata?: Record<string, unknown>;
      };
      onFrame({ data: frame.data, metadata: frame.metadata });
      // Unacknowledged frames stop the stream after a couple of buffers.
      void chrome.debugger
        .sendCommand({ tabId }, "Page.screencastFrameAck", {
          sessionId: frame.sessionId,
        })
        .catch(() => undefined);
    };

    chrome.debugger.onEvent.addListener(listener);
    this.screencasts.set(tabId, listener);

    await this.send(tabId, "Page.enable", {});
    await this.send(tabId, "Page.startScreencast", {
      format: options.format ?? "jpeg",
      quality: options.quality ?? 80,
      everyNthFrame: options.everyNthFrame ?? 1,
      ...(options.maxWidth ? { maxWidth: options.maxWidth } : {}),
      ...(options.maxHeight ? { maxHeight: options.maxHeight } : {}),
    });
  }

  async stopScreencast(tabId: number): Promise<void> {
    const listener = this.screencasts.get(tabId);
    if (!listener) return;
    this.screencasts.delete(tabId);
    chrome.debugger.onEvent.removeListener(listener);
    try {
      await this.send(tabId, "Page.stopScreencast", {});
    } catch {
      /* the tab may already be gone */
    }
    await this.detach(tabId);
  }

  private send(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  // Animate the visible overlay in the page while CDP delivers trusted input.
  private showCursor(tabId: number, samples: CursorSample[]): void {
    chrome.tabs
      .sendMessage(tabId, {
        v: PROTOCOL_VERSION,
        id: "",
        command: { kind: "showCursorPath", samples },
      })
      .catch(() => undefined);
  }

  private async move(tabId: number, samples: CursorSample[]): Promise<void> {
    this.showCursor(tabId, samples);
    const start = performance.now();
    for (const s of samples) {
      await sleepUntil(start + s.t);
      await this.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: s.x,
        y: s.y,
      });
    }
  }

  private async click(
    tabId: number,
    target: Point,
    button: MouseButton,
    dbl: boolean,
    pressMs: number,
  ): Promise<void> {
    await this.press(tabId, target, button, 1);
    await sleep(pressMs);
    await this.release(tabId, target, button, 1);
    if (dbl) {
      await this.press(tabId, target, button, 2);
      await sleep(pressMs);
      await this.release(tabId, target, button, 2);
    }
  }

  private press(tabId: number, target: Point, button: MouseButton, clickCount: number): Promise<unknown> {
    return this.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button,
      buttons: cdpButtonsMask(button),
      clickCount,
    });
  }

  private release(tabId: number, target: Point, button: MouseButton, clickCount: number): Promise<unknown> {
    return this.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button,
      buttons: 0,
      clickCount,
    });
  }

  private async type(tabId: number, text: string, _min: number, _max: number): Promise<void> {
    // Insert the whole string in one call. Per-char insertText lands at a reset
    // caret on controlled editors (X's Draft.js) and types the text backward.
    await this.send(tabId, "Input.insertText", { text });
  }

  private async scroll(tabId: number, dx: number, dy: number, steps: number): Promise<void> {
    const count = Math.max(1, steps);
    for (let i = 0; i < count; i++) {
      await this.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 100,
        y: 100,
        deltaX: dx / count,
        deltaY: dy / count,
      });
      await sleep(rand(12, 28));
    }
  }

  private async drag(tabId: number, samples: CursorSample[], target: Point, button: MouseButton): Promise<void> {
    // Real drag: press at the start, move the path with the button held, release at the end.
    const start = samples[0] ?? target;
    this.showCursor(tabId, samples);
    await this.press(tabId, start, button, 1);
    const buttons = cdpButtonsMask(button);
    const t0 = performance.now();
    for (const s of samples) {
      await sleepUntil(t0 + s.t);
      await this.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: s.x,
        y: s.y,
        button,
        buttons,
      });
    }
    await sleep(rand(40, 90));
    await this.release(tabId, target, button, 1);
  }

  private async pressKey(tabId: number, key: string): Promise<void> {
    const info = CDP_KEYS[key] ?? { code: key, vk: 0 };
    for (const type of ["rawKeyDown", "keyUp"] as const) {
      await this.send(tabId, "Input.dispatchKeyEvent", {
        type,
        key,
        code: info.code,
        windowsVirtualKeyCode: info.vk,
        nativeVirtualKeyCode: info.vk,
      });
    }
  }
}
