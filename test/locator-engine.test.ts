// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { evaluateSpec } from "../extension/src/locator-engine";

beforeEach(() => {
  document.body.innerHTML = `
    <div class="row" data-testid="row-1">
      <button>Edit</button>
      <button aria-label="Delete row">x</button>
    </div>
    <div class="row">
      <button>Edit</button>
      <span>Pro plan</span>
    </div>
    <label for="email">Email</label>
    <input id="email" placeholder="you@example.com" />
    <input aria-label="Search" placeholder="Search here" />
  `;
});

describe("evaluateSpec", () => {
  it("css", () => {
    expect(evaluateSpec([{ kind: "css", value: ".row" }]).length).toBe(2);
  });

  it("matches text by substring, case-insensitively, like Playwright", () => {
    expect(evaluateSpec([{ kind: "text", value: "Pro" }]).length).toBe(1);
    expect(evaluateSpec([{ kind: "text", value: "pro plan" }]).length).toBe(1);
  });

  it("honours exact when asked", () => {
    expect(evaluateSpec([{ kind: "text", value: "Pro", exact: true }]).length).toBe(0);
    expect(evaluateSpec([{ kind: "text", value: "Pro plan", exact: true }]).length).toBe(1);
  });

  it("matches a role's accessible name by substring", () => {
    const els = evaluateSpec([{ kind: "role", value: "button", name: "Delete" }]);
    expect(els.length).toBe(1);
    expect(els[0]?.getAttribute("aria-label")).toBe("Delete row");
  });

  it("role + name", () => {
    const els = evaluateSpec([{ kind: "role", value: "button", name: "Delete row" }]);
    expect(els.length).toBe(1);
    expect(els[0]?.getAttribute("aria-label")).toBe("Delete row");
  });

  it("text matches the two buttons, not their containers", () => {
    expect(evaluateSpec([{ kind: "text", value: "Edit" }]).length).toBe(2);
  });

  it("label resolves the associated control", () => {
    const els = evaluateSpec([{ kind: "label", value: "Email" }]);
    expect((els[0] as HTMLInputElement)?.id).toBe("email");
  });

  it("placeholder", () => {
    const els = evaluateSpec([{ kind: "placeholder", value: "Search here" }]);
    expect(els.length).toBe(1);
  });

  it("testid", () => {
    expect(evaluateSpec([{ kind: "testid", value: "row-1" }]).length).toBe(1);
  });

  it("chaining narrows to descendants of each match", () => {
    const els = evaluateSpec([
      { kind: "css", value: ".row" },
      { kind: "text", value: "Edit" },
    ]);
    expect(els.length).toBe(2);
  });

  it("filter by hasText", () => {
    const els = evaluateSpec([
      { kind: "css", value: ".row" },
      { kind: "filter", hasText: "Pro" },
    ]);
    expect(els.length).toBe(1);
    expect(els[0]?.textContent).toContain("Pro plan");
  });

  it("nth, first, last", () => {
    const all = evaluateSpec([{ kind: "text", value: "Edit" }]);
    const first = evaluateSpec([{ kind: "text", value: "Edit" }, { kind: "nth", index: 0 }]);
    const last = evaluateSpec([{ kind: "text", value: "Edit" }, { kind: "nth", index: -1 }]);
    expect(first.length).toBe(1);
    expect(first[0]).toBe(all[0]);
    expect(last[0]).toBe(all[all.length - 1]);
  });
});
