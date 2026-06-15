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
- `test-detector/` — a local realism scoring page.

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
```

- Keep the path engine covered by tests in `test/`.
- Follow the existing style: small single-purpose modules, minimal comments
  (names over narration; a one-line comment only for a non-obvious why).
- No new runtime dependency without discussion.

## Scope

Phase 1 is the Chrome extension. Phase 2 is the macOS OS-cursor driver. Please
open an issue before starting large work so we can align on the interface.
