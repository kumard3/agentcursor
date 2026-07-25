// Full-feature live drive: connects via the SDK to the running Chrome + extension
// on 8930 and exercises EVERY feature against the showcase, paced for screen
// recording. Content mode (no debugger banner). After connect it navigates the
// active tab to the showcase, waits a lead-in for you to start recording, then
// drives: click-by-text, type/fill, hover-menu, drag, scroll, press, screenshot.
import { AgentCursor } from "../dist/lib.js";

const PORT = Number(process.env.AGENTCURSOR_WS_PORT ?? 8930);
const PAGE = process.env.LIVE_URL ?? "http://localhost:8123/showcase.html";
const LEAD_IN_MS = Number(process.env.LEAD_IN_MS ?? 8000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`▶ ${m}`);

async function main() {
  console.log(`connecting SDK on ws:${PORT} …`);
  const ac = await AgentCursor.connect({ port: PORT, stealth: false, timeoutMs: 30_000 });
  console.log("✓ connected to the extension\n");

  await ac.navigate(PAGE);
  await sleep(1500);
  console.log(`navigated to showcase — START RECORDING NOW (driving in ${LEAD_IN_MS / 1000}s)`);
  await sleep(LEAD_IN_MS);

  step("click by text: Buy now");
  await ac.getByText("Buy now").click();
  await sleep(1100);
  step("click by text: Like, then Reply");
  await ac.getByText("Like").click();
  await sleep(700);
  await ac.getByText("Reply").click();
  await sleep(1000);

  step("type into fields: Email / Name / Message");
  await ac.getByLabel("Email").fill("agent@cursor.dev");
  await sleep(700);
  await ac.getByLabel("Name").fill("Kumar Deepanshu");
  await sleep(700);
  await ac.getByLabel("Message").fill("agentcursor is driving this");
  await sleep(1000);

  step("hover to open the Menu submenu");
  await ac.getByRole("button", { name: "Menu" }).hover();
  await sleep(1600);

  step("drag the box");
  const box = await ac.locator("#box").boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await ac.actions.drag({ x: cx, y: cy }, { x: cx + 190, y: cy + 28 });
  }
  await sleep(1100);

  step("drag the volume slider");
  const sl = await ac.locator("#range").boundingBox();
  if (sl) {
    const y = sl.y + sl.height / 2;
    await ac.actions.drag({ x: sl.x + 6, y }, { x: sl.x + sl.width * 0.78, y });
  }
  await sleep(1100);

  step("scroll down then back up");
  await ac.scroll({ dy: 520 });
  await sleep(800);
  await ac.scroll({ dy: -520 });
  await sleep(900);

  step("press a key: Enter in Message (submits the form)");
  await ac.getByLabel("Message").press("Enter");
  await sleep(900);

  step("screenshot");
  await ac.screenshot({ path: "/tmp/ac-full-demo.png" });

  await ac.close();
  console.log("\n✓ full-feature drive complete");
  process.exit(0);
}

main().catch((e) => {
  console.error("drive error:", e.message);
  process.exit(1);
});
