import type { Point } from "../../src/protocol";

const ARROW_SVG = `<svg width="20" height="22" viewBox="0 0 20 22" xmlns="http://www.w3.org/2000/svg"><path d="M2 2 L2 17 L6 13 L9 19 L12 18 L9 12 L15 12 Z" fill="#ffffff" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

/** A non-interactive cursor drawn on top of the page so the agent's pointer is visible. */
export class CursorOverlay {
  private readonly el: HTMLDivElement;
  private x = 0;
  private y = 0;

  constructor() {
    this.el = document.createElement("div");
    this.el.setAttribute("data-ghosthand", "cursor");
    Object.assign(this.el.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "20px",
      height: "22px",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: "translate(-100px, -100px)",
      filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.4))",
    } satisfies Partial<CSSStyleDeclaration>);
    this.el.innerHTML = ARROW_SVG;
  }

  private ensureMounted(): void {
    if (!this.el.isConnected) {
      (document.body ?? document.documentElement).appendChild(this.el);
    }
  }

  moveTo(x: number, y: number): void {
    this.ensureMounted();
    this.x = x;
    this.y = y;
    this.el.style.transform = `translate(${x}px, ${y}px)`;
  }

  get pos(): Point {
    return { x: this.x, y: this.y };
  }
}
