// End-to-end SDK run: the AgentCursor library hosts the WebSocket, a simulated
// browser connects as the extension would, and we drive the Playwright-shaped
// locator API. Exercises lib -> ActionService -> human-path engine -> driver -> WS,
// including resolveLocator. A live Chrome with the extension is the only piece
// not covered here.
import { WebSocket } from "ws";
import { AgentCursor } from "../dist/lib.js";

const PORT = Number(process.env.SDK_SMOKE_PORT ?? "8788");

function answer(cmd, captured) {
  captured.kinds.push(cmd.kind);
  switch (cmd.kind) {
    case "cursorState":
      return { x: 20, y: 30 };
    case "getUrl":
      return "https://example.com";
    case "snapshot":
      return {
        url: "https://example.com",
        title: "Example",
        viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
        elements: [],
        text: "",
      };
    case "resolveLocator":
      return { handle: "loc1", rect: { x: 400, y: 300, width: 120, height: 40 }, count: 1, visible: true, text: "Buy now" };
    case "replayMove":
    case "replayClick":
      captured.lastSamples = cmd.samples;
      return null;
    case "type":
      captured.typed = cmd;
      return null;
    default:
      return null;
  }
}

function startFakeExtension(captured) {
  let ws;
  const tryConnect = () => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("error", () => setTimeout(tryConnect, 100));
    ws.on("message", (raw) => {
      const env = JSON.parse(raw.toString());
      if (!env.command) return;
      ws.send(JSON.stringify({ id: env.id, ok: true, data: answer(env.command, captured) }));
    });
  };
  tryConnect();
  return () => ws?.close();
}

async function main() {
  const captured = { kinds: [], lastSamples: null, typed: null };
  const stop = startFakeExtension(captured);

  const ac = await AgentCursor.connect({ port: PORT, timeoutMs: 8000 });
  console.log("✓ AgentCursor connected over WebSocket\n");

  await ac.getByText("Buy now").click();
  console.log("getByText('Buy now').click() →", `${captured.lastSamples?.length ?? 0} cursor samples`);
  await ac.getByLabel("Email").fill("a@b.com");
  await ac.getByRole("button", { name: "Submit" }).hover();
  const box = await ac.locator("#x").boundingBox();
  const visible = await ac.getByText("Buy now").isVisible();
  const count = await ac.getByText("Buy now").count();
  console.log(`boundingBox → ${JSON.stringify(box)}`);
  console.log(`isVisible → ${visible}   count → ${count}\n`);
  console.log(`commands the browser received: ${captured.kinds.join(", ")}\n`);

  await ac.close();
  stop();

  const samples = captured.lastSamples ?? [];
  const straightness = (() => {
    if (samples.length < 2) return 1;
    const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    let len = 0;
    for (let i = 1; i < samples.length; i++) len += d(samples[i - 1], samples[i]);
    return d(samples[0], samples.at(-1)) / len;
  })();

  const checks = {
    "locator click resolved + drove the cursor": captured.kinds.includes("resolveLocator") && captured.kinds.includes("replayClick"),
    "cursor path generated": samples.length > 8,
    "path is curved, not straight": straightness < 0.999,
    "fill() requested value replace": captured.typed?.replace === true,
    "boundingBox returns the resolved rect": !!box && box.width === 120,
    "isVisible reflects the match": visible === true,
    "count reflects the match": count === 1,
  };

  console.log("");
  let allOk = true;
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? "✓" : "✗"} ${name}`);
    allOk &&= pass;
  }
  if (!allOk) process.exit(1);
  console.log("\n✓ SDK end-to-end OK (AgentCursor → locator → human-path engine → browser)");
  process.exit(0);
}

main().catch((e) => {
  console.error("sdk-smoke error:", e);
  process.exit(1);
});
