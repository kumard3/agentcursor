// Real end-to-end tests: each AgentCursor.launch() starts its own Chrome with
// its own visible cursor, independent of your mouse and the MCP server.
// Run: pnpm e2e   (HEADLESS=1 pnpm e2e for CI)
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { AgentCursor, expect } from "../../dist/lib.js";

const headless = !!process.env.HEADLESS;
let server;
let base;

before(async () => {
  const page = await readFile(new URL("../../test-detector/showcase.html", import.meta.url));
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(page));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/showcase.html`;
});
after(() => server.close());

test("buy, hover menu, fill and submit the form", async () => {
  const ac = await AgentCursor.launch({ headless, seed: 7 });
  try {
    await ac.goto(base);
    await expect(ac).toHaveURL(/showcase\.html$/);

    await ac.getByRole("button", { name: "Buy now" }).click();
    await expect(ac.locator("#banner")).toContainText("Buy now");

    await expect(ac.getByText("Settings")).toBeHidden();
    await ac.getByRole("button", { name: "Menu" }).hover();
    await expect(ac.getByText("Settings")).toBeVisible();

    await ac.getByLabel("Email").fill("agent@cursor.dev");
    await ac.getByRole("button", { name: "Submit" }).click();
    await expect(ac.locator("#formlog")).toContainText("submitted as agent@cursor.dev");
    await expect(ac.getByRole("button")).not.toHaveCount(0);
  } finally {
    await ac.close();
  }
});

test("two cursors in two browsers at once", async () => {
  const size = "--window-size=760,900";
  const [alice, bob] = await Promise.all([
    AgentCursor.launch({ headless, seed: 1, args: [size, "--window-position=0,0"] }),
    AgentCursor.launch({ headless, seed: 2, args: [size, "--window-position=780,0"] }),
  ]);
  try {
    await Promise.all([alice.goto(base), bob.goto(base)]);
    await Promise.all([
      alice.getByRole("button", { name: "Like" }).click(),
      bob.getByRole("button", { name: "Share" }).click(),
    ]);
    await expect(alice.locator("#banner")).toContainText("Like");
    await expect(bob.locator("#banner")).toContainText("Share");
    await expect(alice.locator("#banner")).not.toContainText("Share");
  } finally {
    await Promise.all([alice.close(), bob.close()]);
  }
});
