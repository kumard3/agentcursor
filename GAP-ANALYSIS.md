# AgentCursor — Gap Analysis & Production Roadmap

**Goal**: Make AgentCursor production-ready for real commercial websites and the default **local, free, human-cursor browser tool** that *any* coding agent (Claude Code, Cursor, Grok, Continue, custom agents, scripts, etc.) can connect to via **MCP (primary) or a simple local API**.

Date of audit: 2026-06-16

## Current State — Strengths

- Clean architecture with strong separation (MCP layer → ActionService → PathEngine → BrowserDriver abstraction).
- Excellent human-like path engine (Fitts + overshoot + jitter + dwell + off-center + per-call entropy). Unit tested.
- Two delivery mechanisms already working:
  - Visible cursor overlay (content script) — great for demos and watching.
  - `chrome.debugger` stealth mode (`isTrusted=true`).
  - Phase 2: macOS real OS cursor via optional `@nut-tree-fork/nut-js` (genuinely trusted events).
- Already speaks real MCP over stdio using the official SDK. Claude example in README works.
- Protocol is versioned and shared between Node + extension.
- Good developer scripts (`smoke`, `verify-live`, `demo`).
- MIT license, focused scope (the missing human cursor piece that other browser MCPs often hide behind paywalls).
- Local-only by design (WS on 127.0.0.1, stdio MCP).

**It is not a toy.** The hard part (realistic movement that survives behavioral detection) is already solved well.

## Critical Gaps (for "real sites" + "any agent")

### Tier 1 — Must fix to be usable on real sites & attractive to any agent

| Gap | Impact | Current Behavior | Needed |
|-----|--------|------------------|--------|
| **read_page / snapshot quality** | Highest | Fixed `INTERACTIVE_SELECTOR` + `querySelectorAll`. No shadow DOM piercing. Ignores most of viewport after scroll. Poor labels/roles on modern component libraries. | Deep traversal (shadow roots, slotted content), better visibility + in-viewport filtering, stable refs that survive minor DOM churn, richer element descriptors (text, placeholder, nearby label). Optional "full" vs "interactive-only" mode. |
| **Action surface too narrow** | High | Basic move/click/type/scroll/navigate/wait. No hover, no drag, no file upload, weak select handling, no keyboard shortcuts beyond typing. | Add `hover`, `drag`, `upload`, `pressKey`, `selectOption`. Make `wait_for` more powerful (visible, enabled, count, etc.). |
| **No visual grounding (screenshot)** | High for agents | None. Agents are flying blind after actions on complex SPAs. | Add `screenshot` tool (base64 PNG or save to path). Critical for "see the page → plan actions". |
| **No status / health / diagnostics tool** | High | Agents (and humans) have no easy way to know if extension is connected, which tab/driver is active, last errors, etc. | New `status` (and maybe `ping`) tool. Return connection state, driver, focused tab info, protocol version, etc. |
| **MCP surface is minimal** | Medium-High | Only 8 tools, no resources, no prompts. | Richer tool descriptions with usage guidance. Add MCP `prompts` (e.g. "human-browser-workflow"). Consider resources (`current-page-snapshot`, `last-action-log`). |
| **Claude-only docs & examples** | High for adoption | README shows only `claude mcp add`. | Clear instructions + config snippets for Cursor, Windsurf, Continue.dev, custom MCP clients, Grok harness, direct Node usage. |

### Tier 2 — Production reliability & real-site robustness

- **Stale refs & snapshot staleness**: ActionService caches one snapshot. Heavy SPAs, infinite scroll, modals, or route changes break refs constantly. Need smarter re-snapshot on failure + optional "force refresh".
- **Wait / synchronization primitives**: Current `wait_for` is crude (ref in map or text in body). Real sites need "wait for network idle-ish", element stable, attribute change, etc.
- **Error handling & recovery**: Mid-action disconnects, content script not present, tab crashes, permission issues are handled inconsistently. Many raw throws.
- **Coordinate / geometry robustness** (especially OS driver): Assumes 100% zoom + single monitor + Chrome window not moved. Multi-monitor, fractional scaling, browser zoom, side panels break mapping.
- **Anti-bot completeness note**: Cursor realism helps a lot, but real sites also look at CDP leaks, `navigator.webdriver`, timing patterns, TLS fingerprint, etc. Document limitations honestly. `stealth` + OS driver are the current best options.
- **Tab & window model**: Always "last focused window + active tab". No explicit tab selection, no handling of popups/new tabs, no multi-tab workflows.
- **Testing**: Only path-engine + coord map unit tests. No integration tests against real pages, no snapshot quality regression tests.
- **Logging & observability**: Minimal. Hard to debug "why did the click land wrong on this site?"
- **Reconnection & lifecycle**: Extension service worker keepalive exists but fragile. Server has no graceful shutdown or client-count awareness.
- **Modern web gotchas**: No special handling for cookie banners, consent modals, fixed overlays that intercept events, password managers, virtual keyboards on mobile viewports, etc.

### Tier 3 — "MCP or API", distribution, and "use my tool" goal

- **Programmatic / API access**: Everything is hidden behind the MCP stdio server today. For your own agents or non-MCP code you want to `import` the power or talk to a running instance.
  - Export the core library cleanly (`ActionService`, `BrowserDriver`, path engine, etc.).
  - Consider an optional local HTTP/WS API mode (e.g. `--api-port 8931`) that accepts the same tool calls as JSON for maximum compatibility.
  - Or document the internal WS protocol so advanced users can drive the extension directly.
- **Packaging & install friction**:
  - Icons directory appears empty (Chrome extension looks bad).
  - No published npm package yet with good `bin`.
  - No one-line install for non-dev users.
  - Version is still 0.1.0 with no changelog.
- **Config surface**: Only a couple of `AGENTCURSOR_*` env vars. Needs more (default maxElements, dwell profiles, default driver, log level, allowed origins if we ever add HTTP).
- **Security / privacy story**: Already very good (all local), but needs a clear section: "What this extension can see/do", "Requires Accessibility on mac for OS driver", "Never run on untrusted machines".
- **"Universal tool" positioning**: The value prop is excellent ("the human cursor piece everyone else paywalls"). We need to make it the obvious default by having rock-solid MCP experience + easy examples for every major agent harness.

## Recommended Strategy

1. **Primary interface = excellent MCP** (stdio). This is how most coding agents will consume it going forward (Claude, Cursor and many new ones already speak MCP). Make the tools feel first-class.
2. **Secondary = reusable core library**. Export `ActionService` + drivers so your personal agent code or other projects can use the same engine without spawning a full MCP server.
3. **Tertiary (if needed)** = tiny optional local API server. Only if there is real demand from agents that refuse MCP.
4. Prioritize Tier 1 items aggressively — they are what prevent "I tried it on Stripe / my SaaS dashboard / login flow and it didn't work."
5. Treat the extension as a "trusted local bridge" that only your own agents talk to. Don't over-engineer multi-client or remote scenarios.

## Prioritized Implementation Roadmap

### Phase 0 — Foundation (do first)
- [ ] Add proper icons to `extension/icons/` (16/48/128 png) + update manifest if needed.
- [ ] Export the core from `src/index.ts` (or new `src/lib.ts`) so `import { ActionService, generateMove, ... } from "agentcursor"` works after build.
- [ ] Add a `status` tool (connection state, driver kind, last known URL, extension version/protocol, errors).
- [ ] Add `screenshot` tool (return base64 or write file). Use `chrome.tabs.captureVisibleTab`.
- [ ] Improve tool descriptions with "when to use / gotchas" text.

### Phase 1 — Real Sites (snapshot + actions)
- [x] Rewrite `buildSnapshot` in content script to pierce shadow DOM (recursive walk with `shadowRoot`). **DONE**.
- [x] Added `ensureVisible` (with fully-in-view skip + auto, DRY calls). ActionService now re-reads snapshot after ensure so move/click/hover/drag use post-scroll rects (prevents stale coord clicks on scrolled pages).
- [x] Improved `wait_for` with visibility check for refs (better for dynamic UIs).
- [x] Hover + DRY orchestration in ActionService.
- [x] Improve element selection: compute better `name` (aria-labelledby, nearby label text, data-testid, getBetterName), add `visible` / `inViewport` flags. DRY isVisible/isInViewport helpers.
- [x] Add basic `hover(ref | x,y)` action. (with DRY ensureVisible)
- [x] Make `wait_for` accept more conditions (exists/visible/text) + poll smarter (120ms, visibility check). DRY isVisible.
- [x] Auto-refresh snapshot on failures (findElement does 2 reads).
- [x] Add `scrollIntoView` behavior (ensureVisible + DRY calls before actions).

### Phase 2 — Reliability & Polish
- [x] Centralized ensureVisible (DRY; improved skip-when-fully-visible + behavior:auto + short settle). Duplicate ensure in replayClick removed.
- [x] Improved wait_for with actual visibility checks.
- [x] Structured logging started (log() helper in timing utils, prefixed calls in service-worker and content for connections, commands).
- [x] ensureVisible + scrollIntoView behavior (Phase 1/2 crossover).
- [x] Better full reconnection/cancellation (existing auto-reconnect in SW + alarms + logs).
- [x] Coord-map updated with limitation warning.
- [x] Smoke/verify updated to cover new tools (ensureVisible, drag).
- Tab diagnostics via status (active tab always used).

### Phase 3 — Universal Agent Adoption
- [x] Richer MCP: added "human-browser-task" prompt + new tools (screenshot, hover, drag, status, ensureVisible).
- [x] Docs significantly updated: X/Reddit posting example for Claude, production notes, changelog, programmatic use, drag/hover/status.
- [x] Optional HTTP API mode (AGENTCURSOR_HTTP_PORT, minimal POST /call stub for get_url/status only; bound to 127.0.0.1).
- [ ] Publish to npm with correct `files`, `bin`, `repository`.
- [x] Smoke script serves as strong E2E example; README has agent usage examples.
- [x] Production checklist partially in README (real sites section).
- Richer MCP prompts added.

### Phase 4 — Nice to have later
- [x] Basic `drag` tool implemented (human path while button held; content replays press+move+release, debugger has stub). Good starting point for drag-drop, sliders. DRY reuse of move/replay.
- [ ] File upload (upload tool registration removed until full impl; was a misleading stub).
- [ ] Full advanced keyboard, true continuous drag.
- [ ] Multi-tab / popup support (currently always active tab; status reports it).
- [ ] Config file + profiles (different "personalities" for the cursor).
- [ ] Optional "headful recording" of sessions for debugging.
- [ ] Better OS driver support on other platforms (Windows/Linux via nut-js or alternatives).

## Non-Goals / Honest Limitations

- This will never be a full replacement for Playwright/Puppeteer for *headless* scraping or massive scale. It is intentionally "human in a real Chrome window you are watching".
- It will still be detectable by very sophisticated non-mouse signals on some sites. The goal is "good enough for the sites that mostly rely on behavioral mouse + basic CDP".
- No plans for remote / multi-user / cloud version (keep it local and free).

## How to Verify "Production Ready"

1. Can run `pnpm verify` or equivalent against a real logged-in session on 3-5 commercial sites (Stripe dashboard, a SaaS app, Gmail or similar, a checkout flow) without constant ref-not-found or click misses.
2. Any MCP-capable agent (Claude, Cursor, your Grok harness, a custom one) can add it with 2-3 lines and successfully complete a non-trivial browser task end-to-end.
3. Programmatic use: `import { ActionService } from "agentcursor"` works for your internal agents.
4. Clear docs so a new user can get it running on their machine in <10 minutes.

---

**Owner**: Deepanshu (original author). This is an audit + proposed plan. Next step: pick the order of Phase 0/1 items and start shipping.
