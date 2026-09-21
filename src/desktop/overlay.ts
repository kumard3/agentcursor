import { spawn, type ChildProcess } from "node:child_process";
import type { CursorSample, Point } from "../protocol";
import { helperPath } from "./ax";

export interface OverlayOptions {
  /** Hex colour of this session's cursor, e.g. "#4ade80". */
  color?: string;
  /** Name shown next to it, so two tests are told apart on screen. */
  label?: string;
}

/**
 * A cursor of this session's own, drawn above every window and click-through.
 * Background input does not move the system pointer, so this is what makes a
 * background run watchable: one per session, each with its own colour.
 */
export class CursorOverlay {
  private proc: ChildProcess | null = null;

  constructor(private readonly opts: OverlayOptions = {}) {}

  private child(): ChildProcess {
    if (!this.proc || this.proc.exitCode !== null) {
      const args = ["overlay"];
      if (this.opts.color) args.push("--color", this.opts.color);
      if (this.opts.label) args.push("--label", this.opts.label);
      this.proc = spawn(helperPath, args, { stdio: ["pipe", "ignore", "ignore"] });
      this.proc.on("error", () => (this.proc = null));
    }
    return this.proc;
  }

  at(p: Point): void {
    this.child().stdin?.write(`${Math.round(p.x)} ${Math.round(p.y)}\n`);
  }

  /** Follows a move with the same timing the posted events use. */
  async play(samples: CursorSample[]): Promise<void> {
    const start = Date.now();
    for (const s of samples) {
      const wait = s.t - (Date.now() - start);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.at(s);
    }
  }

  close(): void {
    this.proc?.stdin?.end("bye\n");
    this.proc = null;
  }
}
