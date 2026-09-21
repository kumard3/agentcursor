// Computer use against a browser that is already open and signed in: no
// extension, no DOM, just the macOS accessibility tree and the real cursor.
// Switches to the tab you name, reads the page, and moves the cursor to it.
//
//   AC_TAB="My App" node --test test/e2e/running-browser.e2e.mjs
//   AC_APP=Arc AC_TAB=Dashboard AC_CLICK=1 pnpm e2e
//
// Skips unless AC_TAB is set, since it drives your real browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Desktop } from "../../dist/lib.js";

const APP = process.env.AC_APP ?? "Arc";
const TAB = process.env.AC_TAB;
const OUT = process.env.AGENTCURSOR_OUT ?? "/tmp";

test(`drive a running ${APP} tab with the real cursor`, async (t) => {
  if (!TAB) return t.skip("set AC_TAB to the tab you want driven");
  const want = new RegExp(TAB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  const d = await Desktop.open();
  if (!(await d.apps()).some((a) => a.name === APP)) return t.skip(`${APP} is not running`);
  await d.activate(APP);
  let view = await d.view({ max: 250 });

  // The tab may be open but not frontmost: switch to it the way a person would.
  if (!want.test(view.window.title)) {
    const tab = view.elements.find((e) => e.role === "button" && want.test(e.name));
    assert.ok(tab, `no tab matching ${TAB} is open in ${APP}`);
    console.log(`    switched: ${await d.click(tab.ref)}`);
    view = await d.view({ max: 250 });
  }
  assert.match(view.window.title, want, `the front ${APP} window should be the ${TAB} tab`);

  const matches = await d.elements(TAB);
  assert.ok(matches.length > 0, `nothing labelled ${TAB} in the accessibility tree`);

  // Move by default: this is a real, signed-in page. AC_CLICK=1 to click instead.
  const acted = process.env.AC_CLICK ? await d.click(matches[0].ref) : await d.move(matches[0].ref);
  assert.match(acted, /\(\d+, \d+\)/, "the cursor should report where it landed");

  const read = await d.read({ max: 250 });
  const file = await d.screenshot({ app: APP, path: `${OUT}/${APP.toLowerCase()}-tab.png` });
  console.log(`    window  : ${view.window.title}`);
  console.log(`    read    : ${view.elements.length} elements, ${read.length} chars ~${Math.round(read.length / 3.5)} tok`);
  console.log(`    ${process.env.AC_CLICK ? "clicked" : "moved to"}: ${acted}`);
  console.log(`    shot    : ${file}`);
});
