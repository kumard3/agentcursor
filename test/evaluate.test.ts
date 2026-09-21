import { describe, expect, it } from "vitest";
import { buildEvalExpression } from "../src/protocol";

describe("buildEvalExpression", () => {
  it("wraps a no-arg function into a self-call", () => {
    expect(buildEvalExpression("() => document.title")).toBe("(() => document.title)()");
  });

  it("JSON-encodes args so page code sees real values", () => {
    expect(buildEvalExpression("(a, b) => a + b", [1, "x"])).toBe('((a, b) => a + b)(1,"x")');
  });

  it("passes objects through for fetch bodies", () => {
    expect(buildEvalExpression("(o) => o.id", [{ id: 7 }])).toBe('((o) => o.id)({"id":7})');
  });
});
