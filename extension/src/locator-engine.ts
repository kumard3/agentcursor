import { within } from "@testing-library/dom";
import type { LocatorSpec, LocatorStep } from "../../src/protocol";

type QueryStep = Extract<
  LocatorStep,
  { kind: "css" | "role" | "text" | "label" | "placeholder" | "testid" }
>;

function queryWithin(scope: Element, step: QueryStep): Element[] {
  if (step.kind === "css") {
    return Array.from(scope.querySelectorAll(step.value));
  }
  const w = within(scope as HTMLElement);
  const exact = (step as { exact?: boolean }).exact ?? true;
  switch (step.kind) {
    case "role":
      return w.queryAllByRole(step.value, { name: step.name });
    case "text":
      return w.queryAllByText(step.value, { exact });
    case "label":
      return w.queryAllByLabelText(step.value, { exact });
    case "placeholder":
      return w.queryAllByPlaceholderText(step.value, { exact });
    case "testid":
      return w.queryAllByTestId(step.value, { exact });
  }
}

/**
 * Resolves a serializable LocatorSpec against the live DOM, narrowing the
 * candidate set step by step. Query steps search within the previous step's
 * matches (Playwright-style chaining); filter/nth refine the current set.
 */
export function evaluateSpec(spec: LocatorSpec, root: Element = document.body): Element[] {
  let scopes: Element[] = [root];
  let current: Element[] = [root];
  for (const step of spec) {
    if (step.kind === "filter") {
      const q = step.hasText.toLowerCase();
      current = current.filter((el) => (el.textContent ?? "").toLowerCase().includes(q));
      scopes = current;
      continue;
    }
    if (step.kind === "nth") {
      const i = step.index < 0 ? current.length + step.index : step.index;
      const el = current[i];
      current = el ? [el] : [];
      scopes = current;
      continue;
    }
    const found: Element[] = [];
    const seen = new Set<Element>();
    for (const scope of scopes) {
      for (const el of queryWithin(scope, step)) {
        if (!seen.has(el)) {
          seen.add(el);
          found.push(el);
        }
      }
    }
    current = found;
    scopes = found;
  }
  return current;
}
