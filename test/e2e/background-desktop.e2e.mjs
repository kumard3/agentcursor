// Background computer use: input is posted straight to the target process, so
// the user's pointer never moves, the app is never raised, and each session
// keeps a cursor of its own. Works for native (AppKit) apps; Chromium and
// Electron apps ignore process-posted events, so drive browsers with
// AgentCursor.launch({ headless: true }) instead, which is background anyway.
//
// Run: AC_DESKTOP=1 pnpm e2e        (AC_SHOW_CURSOR=1 to watch the cursor)
import assert from "node:assert/strict";
import { test } from "node:test";
import { Desktop } from "../../dist/lib.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("types into a background app without touching your mouse or focus", async (t) => {
  if (process.platform !== "darwin") return t.skip("computer use is macOS only");
  if (!process.env.AC_DESKTOP) return t.skip("set AC_DESKTOP=1: this opens TextEdit on your machine");

  const probe = await Desktop.open();
  const nut = await import("@nut-tree-fork/nut-js").catch(() => null);
  const already = (await probe.apps()).some((a) => a.name === "TextEdit");

  const d = await Desktop.open("TextEdit", {
    background: true,
    seed: 8,
    showCursor: process.env.AC_SHOW_CURSOR ? { color: "#4ade80", label: "test" } : false,
  });
  await sleep(1500);

  const frontBefore = (await probe.apps()).find((a) => a.active)?.name;
  const cursorBefore = nut ? await nut.mouse.getPosition() : null;

  const area = (await d.view({ max: 60 })).elements.find((e) => e.role === "textarea");
  assert.ok(area, "TextEdit should expose a text area");

  const marker = `agentcursor background ${Date.now() % 100000}`;
  await d.click(area.ref);
  await d.type(marker);
  await sleep(800);

  const content = (await d.view({ max: 60 })).elements.map((e) => e.value ?? "").join(" ");
  const frontAfter = (await probe.apps()).find((a) => a.active)?.name;
  const cursorAfter = nut ? await nut.mouse.getPosition() : null;

  console.log(`    typed    : ${content.includes(marker) ? "landed" : "MISSING"} (${marker})`);
  console.log(`    frontmost: ${frontBefore} -> ${frontAfter}`);
  if (cursorBefore && cursorAfter) {
    console.log(`    pointer  : ${cursorBefore.x},${cursorBefore.y} -> ${cursorAfter.x},${cursorAfter.y}`);
  }

  assert.ok(content.includes(marker), "typing should reach the background app");
  assert.equal(frontAfter, frontBefore, "the frontmost app must not change");

  // Put the machine back: close the scratch document without saving.
  await d.key("cmd+w");
  await sleep(900);
  for (const label of ["Delete", "Don't Save"]) {
    const btn = (await d.elements(label))[0];
    if (btn) {
      await d.click(btn.ref);
      break;
    }
  }
  if (!already) await d.key("cmd+q");
  d.close();
});
