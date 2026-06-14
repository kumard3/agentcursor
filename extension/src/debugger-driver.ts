import type { Command, CursorSample, MouseButton, Point } from "../../src/protocol";
import { rand, sleep, sleepUntil } from "./timing";

function cdpButtonsMask(button: MouseButton): number {
  return button === "right" ? 2 : button === "middle" ? 4 : 1;
}

/**
 * Delivers input via chrome.debugger / CDP so events arrive with
 * isTrusted=true. Shows the "debugging this browser" banner while attached.
 */
export class DebuggerDriver {
  private readonly attached = new Set<number>();

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
        default:
          throw new Error(`debugger driver cannot handle '${cmd.kind}'`);
      }
    } finally {
      await this.detach(tabId);
    }
  }

  private async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, "1.3");
    this.attached.add(tabId);
  }

  private async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    this.attached.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* tab may already be gone */
    }
  }

  private send(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  private async move(tabId: number, samples: CursorSample[]): Promise<void> {
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

  private async type(tabId: number, text: string, min: number, max: number): Promise<void> {
    for (const ch of text) {
      await this.send(tabId, "Input.insertText", { text: ch });
      await sleep(rand(min, max));
    }
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
}
