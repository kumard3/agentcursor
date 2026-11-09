# Contributing

Thanks for your interest in AgentCursor.

## Layout

- `src/protocol` — the single source of truth for the wire contract + shared
  types. Both the Node server and the extension import it. Change it here only.
- `src/path-engine` — pure, unit-tested human-path generation. No browser or
  Node I/O. Keep it deterministic-under-seed.
- `src/drivers` — `BrowserDriver` interface and implementations. New delivery
  mechanisms (e.g. the phase-2 OS cursor) implement this interface.
- `src/action` + `src/server` — high-level actions and MCP tool registration.
- `extension/` — the MV3 extension (thin replayer + page reader).
- `native/` - Swift accessibility helper behind the Node `desktop_*` tools.
- `rust/` - the computer use core: one `agentcursor` binary (CLI + MCP). Build with `cd rust && cargo build --release`.
- `test-detector/` — a local realism scoring page.

## Before opening a PR

```bash
pnpm typecheck
pnpm test
pnpm build
```

- Keep the path engine covered by tests in `test/`.
- Follow the existing style: small single-purpose modules, minimal comments
  (names over narration; a one-line comment only for a non-obvious why).
- No new runtime dependency without discussion.

## Scope

Two surfaces: the Chrome extension (with the Node server and SDK) and macOS computer use (the Rust core in `rust/`, plus the Node `desktop_*` tools). The OS-cursor browser driver is optional. Please open an issue before starting large work so we can align on the interface. Read `AGENTS.md` first if you are an agent.
