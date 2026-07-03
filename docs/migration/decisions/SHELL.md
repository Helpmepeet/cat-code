# Shell + transport decision

Decided 2026-06-19 (delegated to me; criterion = best for the user). Spiked against
`~/cat-code`. Supersedes the open transport question in decisions/SEAM-SPIKE.md.

## Decision: Tauri shell + cat-code engine as a Bun sidecar, UI↔engine over a local socket

## Why (the overriding constraint)
cat-code's engine is **Bun-native and already a standalone compiled binary** —
`cli-dev` = Mach-O arm64, 177MB, Bun runtime embedded (`bun build --compile`).
195 `bun:bundle` imports, 56 `Bun.*` calls → **cannot run on Node**.

This inverts the usual "Node-heavy → Electron" advice:
- Electron's core value is embedding **Node**; our engine needs **Bun**, so that value is void.
- The engine runs as a **separate Bun process either way** → that's a sidecar → Tauri's first-class pattern.
- Result: Electron would cost ~165MB+ (Chromium+Node) AND still sidecar the Bun binary;
  Tauri is a ~8-10MB shell + the same Bun binary. Best-for-user = small/fast/native → Tauri.

## What this settles
- **Transport** = local socket/IPC. Reuse cat-code's existing `src/web/AppSessionWebSocketServer`
  (it already wraps `AppSessionController`), but **replace `appSessionEventMapper`** so it
  forwards the **full `SDKMessage`** instead of flattening to a string (the stale-`web/` defect).
- **Seam is headless-safe**: `AppSessionController` + `createQueryEngineAppSession` have ZERO
  Ink/TUI/render imports — runs with no terminal, correct for a sidecar.

## Resolved architecture
```
Tauri shell (Rust: window + sidecar lifecycle + socket proxy)
  └─ spawns cat-code Bun binary as a SIDECAR
       └─ runs AppSessionWebSocketServer  (over AppSessionController → QueryEngine = same core as TUI)
  └─ UI (React, ported from prototype) ⇄ local socket ⇄ sidecar, rendering full SDKMessage
single session for the walking skeleton · N sidecars + session registry (concurrentSessions.ts) for multi-session later
```

## Caveats (carry into Phase 1)
- Tauri introduces **Rust** (thin: spawn sidecar + proxy socket, not deep) — the one new-language cost.
  All-JS fallback is Electron, accepted only if Rust is a dealbreaker.
- **Not yet spiked end-to-end** (Tauri + Bun sidecar + socket). Architecture is well-trodden
  (Hoppscotch 165MB→8MB etc.) but the **walking skeleton (STRATEGY Phase 1) is where it's proven** —
  that's the skeleton's whole job. If the skeleton fails here, revisit Electron before going wider.

## Open sub-question for Phase 1
Reuse `AppSessionWebSocketServer` as-is over the socket, or run `app-runtime` in-process inside a
thin Bun sidecar wrapper and expose our own minimal socket protocol? Decide when building the skeleton.
