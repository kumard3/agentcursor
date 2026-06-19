// AgentCursor SDK quickstart — drive a real Chrome with a human cursor.
//
// Prereqs:
//   1. Build:  pnpm build
//   2. Load the extension: chrome://extensions -> Developer mode -> Load unpacked -> ./extension
//   3. Keep a normal http(s) tab open.
// Then:  node examples/sdk-quickstart.mjs
import { AgentCursor } from "agentcursor";

const ac = await AgentCursor.connect({ stealth: false });
try {
  await ac.navigate("https://example.com");
  console.log("on:", await ac.url());

  // Locate by accessible role + name, then human-move + click.
  await ac.getByRole("link", { name: "More information" }).click();

  console.log("now on:", await ac.url());
  await ac.screenshot({ path: "agentcursor-quickstart.png" });
  console.log("saved agentcursor-quickstart.png");
} finally {
  await ac.close();
}
