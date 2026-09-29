// The agent drives its own background tab while the user's tab stays put.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AgentCursor, expect } from "../../dist/lib.js";

let server;
let base;

before(async () => {
  const page = await readFile(new URL("../../test-detector/showcase.html", import.meta.url));
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(page));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/showcase.html`;
});
after(() => server.close());

test("tabs: drive a background tab without touching the active one", async () => {
  const ac = await AgentCursor.launch({ headless: !!process.env.HEADLESS, seed: 7 });
  try {
    await ac.goto(`${base}?user`);
    const { tabs, pinned } = await ac.tabs({ action: "new", url: `${base}?agent` });
    assert.equal(tabs.find((t) => t.id === pinned)?.active, false);

    await ac.getByRole("button", { name: "Buy now" }).click();
    await expect(ac.locator("#banner")).toContainText("Buy now");
    await assert.rejects(ac.screenshot(), /background/);

    await ac.tabs({ action: "select", url: "?user" });
    await expect(ac).toHaveURL(/\?user$/);
    await expect(ac.locator("#banner")).not.toContainText("Buy now");

    await ac.tabs({ action: "close", id: pinned });
    await assert.rejects(ac.tabs({ action: "select", id: pinned }), /No tab matches/);
  } finally {
    await ac.close();
  }
});
