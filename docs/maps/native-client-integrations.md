# Native Client Integrations Map

Last refreshed: 2026-05-12 against the current source tree.

## Purpose

Daily-refreshable routing map for Chrome/browser automation, computer-use,
native host and installer paths, native TypeScript shims, and the
desktop/mobile/voice command surfaces.

Use this map to choose the first owner files before changing setup, command
exposure, rendering, or validation. It is a routing layer, not the behavioral
source of truth. Verify current code before editing because several paths are
feature-gated, platform-gated, or package-backed.

## First Files To Inspect

| Need | Inspect first | Then inspect |
|---|---|---|
| Broad repo routing | [`WORKSPACE_MAP.md`](WORKSPACE_MAP.md) | This map |
| Startup wiring | [`../../src/main.tsx`](../../src/main.tsx) | [`../../src/entrypoints/cli.tsx`](../../src/entrypoints/cli.tsx), [`../../src/services/mcp/client.ts`](../../src/services/mcp/client.ts) |
| Slash command exposure | [`../../src/commands.ts`](../../src/commands.ts) | Command file below |
| MCP wrapper behavior | [`../../src/services/mcp/client.ts`](../../src/services/mcp/client.ts) | Chrome/computer-use rendering or wrapper file |
| Native install/update | [`../../src/utils/nativeInstaller/installer.ts`](../../src/utils/nativeInstaller/installer.ts) | [`../../src/utils/nativeInstaller/download.ts`](../../src/utils/nativeInstaller/download.ts), [`../../src/utils/nativeInstaller/pidLock.ts`](../../src/utils/nativeInstaller/pidLock.ts) |
| Voice runtime | [`../../src/commands/voice/voice.ts`](../../src/commands/voice/voice.ts) | [`../../src/services/voice.ts`](../../src/services/voice.ts), [`../../src/services/voiceStreamSTT.ts`](../../src/services/voiceStreamSTT.ts) |

## Routing Table

| Concern | Start here | Then inspect | Routing decision |
|---|---|---|---|
| Chrome startup enablement | [`../../src/utils/claudeInChrome/setup.ts`](../../src/utils/claudeInChrome/setup.ts) | [`../../src/main.tsx`](../../src/main.tsx), [`../../src/utils/claudeInChrome/setupPortable.ts`](../../src/utils/claudeInChrome/setupPortable.ts) | Owns `--chrome`/`--no-chrome`, env overrides, config default, extension detection, native host manifest install, dynamic MCP config, allowed tool names, and Chrome prompt injection. |
| Chrome server identity and browser paths | [`../../src/utils/claudeInChrome/common.ts`](../../src/utils/claudeInChrome/common.ts) | [`../../src/utils/browser.ts`](../../src/utils/browser.ts) | Owns reserved server name, Chromium-family browser/profile paths, native messaging host directories, Windows registry keys, socket paths, and browser launch helpers. |
| Chrome MCP package boundary | [`../../src/utils/claudeInChrome/package.ts`](../../src/utils/claudeInChrome/package.ts) | [`../../src/utils/claudeInChrome/mcpServer.ts`](../../src/utils/claudeInChrome/mcpServer.ts) | Package loading is centralized here. If Chrome tools disappear, start by confirming `@ant/claude-for-chrome-mcp` is present and exporting `BROWSER_TOOLS`. |
| Chrome MCP runtime | [`../../src/utils/claudeInChrome/mcpServer.ts`](../../src/utils/claudeInChrome/mcpServer.ts) | [`../../src/services/mcp/client.ts`](../../src/services/mcp/client.ts) | Builds the Chrome context, chooses bridge vs native socket, persists paired device info, wires browser-task inference for ants, and runs the stdio MCP server. |
| Chrome native messaging host | [`../../src/utils/claudeInChrome/chromeNativeHost.ts`](../../src/utils/claudeInChrome/chromeNativeHost.ts) | [`../../src/entrypoints/cli.tsx`](../../src/entrypoints/cli.tsx) | `--chrome-native-host` is a pure TypeScript native host. It bridges Chrome native messaging stdin/stdout to a local socket that MCP clients use. |
| Chrome prompt policy | [`../../src/utils/claudeInChrome/prompt.ts`](../../src/utils/claudeInChrome/prompt.ts) | [`../../src/main.tsx`](../../src/main.tsx) | Explicit enablement injects the browser automation system prompt. Auto-enable injects only a skill hint. |
| `/chrome` command | [`../../src/commands/chrome/index.ts`](../../src/commands/chrome/index.ts) | [`../../src/commands/chrome/chrome.tsx`](../../src/commands/chrome/chrome.tsx) | Local JSX settings surface for extension install/reconnect, permissions link-out, and default-enable toggle. |
| Chrome tool rendering | [`../../src/utils/claudeInChrome/toolRendering.tsx`](../../src/utils/claudeInChrome/toolRendering.tsx) | [`../../src/services/mcp/client.ts`](../../src/services/mcp/client.ts) | Owns user-facing Chrome MCP labels, compact tool-use/result text, tab tracking, and `[View Tab]` links. |
| Computer-use startup gating | [`../../src/utils/computerUse/gates.ts`](../../src/utils/computerUse/gates.ts) | [`../../src/main.tsx`](../../src/main.tsx), [`../../src/utils/computerUse/setup.ts`](../../src/utils/computerUse/setup.ts) | Build flag, macOS, interactive-session, subscription/dogfood, and GrowthBook sub-gates decide whether `computer-use` is added at startup. |
| Computer-use MCP config | [`../../src/utils/computerUse/setup.ts`](../../src/utils/computerUse/setup.ts) | [`../../src/utils/computerUse/common.ts`](../../src/utils/computerUse/common.ts) | Owns the dynamic stdio MCP config and the `mcp__computer-use__*` allowlist that intentionally bypasses normal prompt approval flow. |
| Computer-use MCP server | [`../../src/utils/computerUse/mcpServer.ts`](../../src/utils/computerUse/mcpServer.ts) | [`../../src/utils/computerUse/hostAdapter.ts`](../../src/utils/computerUse/hostAdapter.ts) | The server mostly exists to answer `ListTools` with installed-app hints and to expose the package tool schema over stdio. |
| Computer-use call dispatch | [`../../src/utils/computerUse/wrapper.tsx`](../../src/utils/computerUse/wrapper.tsx) | [`../../src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx`](../../src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx), [`../../src/services/mcp/client.ts`](../../src/services/mcp/client.ts) | Real tool call behavior is rebound here. It owns session-scoped grants, display state, screenshot metadata, lock acquisition, approval dialogs, and abort behavior. |
| Computer-use native executor | [`../../src/utils/computerUse/executor.ts`](../../src/utils/computerUse/executor.ts) | [`../../src/utils/computerUse/swiftLoader.ts`](../../src/utils/computerUse/swiftLoader.ts), [`../../src/utils/computerUse/inputLoader.ts`](../../src/utils/computerUse/inputLoader.ts), [`../../src/utils/computerUse/drainRunLoop.ts`](../../src/utils/computerUse/drainRunLoop.ts) | macOS-only executor wraps `@ant/computer-use-swift` and `@ant/computer-use-input` for screenshots, app enumeration, TCC checks, mouse, keyboard, and clipboard behavior. |
| Computer-use host adapter | [`../../src/utils/computerUse/hostAdapter.ts`](../../src/utils/computerUse/hostAdapter.ts) | [`../../src/utils/computerUse/gates.ts`](../../src/utils/computerUse/gates.ts) | Process-lifetime singleton tying logger, executor, permission checks, and sub-gates into the package adapter contract. |
| Computer-use rendering | [`../../src/utils/computerUse/toolRendering.tsx`](../../src/utils/computerUse/toolRendering.tsx) | [`../../src/services/mcp/client.ts`](../../src/services/mcp/client.ts) | Owns compact labels and summaries for `mcp__computer-use__*` tool messages. |
| Desktop handoff command | [`../../src/commands/desktop/index.ts`](../../src/commands/desktop/index.ts) | [`../../src/commands/desktop/desktop.tsx`](../../src/commands/desktop/desktop.tsx), [`../../src/components/DesktopHandoff.tsx`](../../src/components/DesktopHandoff.tsx), [`../../src/utils/desktopDeepLink.ts`](../../src/utils/desktopDeepLink.ts) | `/desktop` and `/app` are local JSX, macOS/Windows-x64 only, and transfer the current session into Claude Desktop via deep link after flushing session storage. |
| Mobile app command | [`../../src/commands/mobile/index.ts`](../../src/commands/mobile/index.ts) | [`../../src/commands/mobile/mobile.tsx`](../../src/commands/mobile/mobile.tsx) | `/mobile`, `/ios`, and `/android` render QR codes for app-store download links. There is no top-level `mobile/` app directory in this repo. |
| Voice command gate and toggle | [`../../src/commands/voice/index.ts`](../../src/commands/voice/index.ts) | [`../../src/commands/voice/voice.ts`](../../src/commands/voice/voice.ts), [`../../src/voice/voiceModeEnabled.ts`](../../src/voice/voiceModeEnabled.ts) | `/voice` is build-gated by `VOICE_MODE`, runtime-gated by auth plus GrowthBook kill-switch logic, and toggles `settings.voiceEnabled` only after preflight checks. |
| Voice runtime state | [`../../src/context/voice.tsx`](../../src/context/voice.tsx) | [`../../src/state/AppState.tsx`](../../src/state/AppState.tsx), [`../../src/screens/REPL.tsx`](../../src/screens/REPL.tsx) | Voice UI state is provided through the app state tree only in `VOICE_MODE` builds, then consumed by REPL/input surfaces. |
| Voice capture and dependency checks | [`../../src/services/voice.ts`](../../src/services/voice.ts) | [`../../src/commands/voice/voice.ts`](../../src/commands/voice/voice.ts) | Owns native audio load/fallback, recording availability, package-manager install hints, microphone permission probing, and runtime recording backends. |
| Voice STT transport | [`../../src/services/voiceStreamSTT.ts`](../../src/services/voiceStreamSTT.ts) | [`../../src/services/voiceKeyterms.ts`](../../src/services/voiceKeyterms.ts), [`../../src/hooks/useVoice.ts`](../../src/hooks/useVoice.ts) | Owns the OAuth-backed `voice_stream` WebSocket, keepalive/finalize protocol, endpointing, and keyterm forwarding. |
| Native installer public surface | [`../../src/utils/nativeInstaller/index.ts`](../../src/utils/nativeInstaller/index.ts) | [`../../src/utils/nativeInstaller/installer.ts`](../../src/utils/nativeInstaller/installer.ts) | External callers should come through the barrel. It re-exports the installer operations that the rest of the app is allowed to use. |
| Native installer core | [`../../src/utils/nativeInstaller/installer.ts`](../../src/utils/nativeInstaller/installer.ts) | [`../../src/utils/nativeInstaller/download.ts`](../../src/utils/nativeInstaller/download.ts), [`../../src/utils/nativeInstaller/pidLock.ts`](../../src/utils/nativeInstaller/pidLock.ts), [`../../src/utils/nativeInstaller/packageManagers.ts`](../../src/utils/nativeInstaller/packageManagers.ts) | Owns version directories, binary activation, lock handling, cleanup, PATH/alias checks, and install/update sequencing. |
| Native TypeScript shims | [`../../src/native-ts/`](../../src/native-ts/) | Caller listed below | Pure TypeScript replacements for native modules. Preserve caller-facing APIs before changing internals. |

## Startup And Runtime Flow

```text
src/entrypoints/cli.tsx
  handles subprocess flags:
  --claude-in-chrome-mcp
  --chrome-native-host
  --computer-use-mcp

src/main.tsx
  optionally adds Claude in Chrome MCP config
  optionally injects Chrome system prompt or skill hint
  optionally adds computer-use MCP config

src/services/mcp/client.ts
  connects MCP servers
  wraps server tools into local Tool objects
  attaches Chrome rendering overrides
  attaches computer-use wrapper/rendering overrides

tool execution
  Chrome tools follow normal MCP dispatch
  computer-use tools dispatch through wrapper.tsx
```

## Native TS Shim Routes

| Shim | Start here | Primary callers | Decision |
|---|---|---|---|
| `color-diff` | [`../../src/native-ts/color-diff/index.ts`](../../src/native-ts/color-diff/index.ts) | [`../../src/components/StructuredDiff/colorDiff.ts`](../../src/components/StructuredDiff/colorDiff.ts) | Structured diff rendering now always routes through the TS port; env only controls whether syntax highlighting is disabled. |
| `file-index` | [`../../src/native-ts/file-index/index.ts`](../../src/native-ts/file-index/index.ts) | [`../../src/hooks/fileSuggestions.ts`](../../src/hooks/fileSuggestions.ts) | File suggestions depend on the TS fuzzy index API directly; treat it as performance-sensitive shared infrastructure. |
| `yoga-layout` | [`../../src/native-ts/yoga-layout/index.ts`](../../src/native-ts/yoga-layout/index.ts) | [`../../src/ink/layout/yoga.ts`](../../src/ink/layout/yoga.ts), `src/ink/ink.tsx`, `src/ink/reconciler.ts` | Ink layout routes through the TS Yoga-compatible port, not a native binding. |

## Command Surface

| Command | Type | Gate | Primary behavior |
|---|---|---|---|
| `/chrome` | local JSX | `claude-ai`, interactive session | Extension install/reconnect, permissions handoff, default-enable toggle. |
| `/desktop`, `/app` | local JSX | macOS or Windows x64 | Flush session storage and open Claude Desktop to the current session. |
| `/mobile`, `/ios`, `/android` | local JSX | none in command file | Show QR code for downloading the mobile app. |
| `/voice` | local | `VOICE_MODE`, `claude-ai`, auth + GrowthBook gate | Toggle voice mode after recording/tool/mic preflight checks. |

Routing note: `src/commands.ts` conditionally registers `/voice` behind
`feature('VOICE_MODE')` and includes `mobile` in the remote-safe command set.

## Rendering Owners

| Surface | Start here | Then inspect |
|---|---|---|
| Chrome MCP tool rows | [`../../src/utils/claudeInChrome/toolRendering.tsx`](../../src/utils/claudeInChrome/toolRendering.tsx) | [`../../src/services/mcp/client.ts`](../../src/services/mcp/client.ts) |
| Computer-use MCP tool rows | [`../../src/utils/computerUse/toolRendering.tsx`](../../src/utils/computerUse/toolRendering.tsx) | [`../../src/utils/computerUse/wrapper.tsx`](../../src/utils/computerUse/wrapper.tsx), [`../../src/services/mcp/client.ts`](../../src/services/mcp/client.ts) |
| Computer-use approval dialog | [`../../src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx`](../../src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx) | [`../../src/utils/computerUse/wrapper.tsx`](../../src/utils/computerUse/wrapper.tsx) |
| Desktop handoff UI | [`../../src/components/DesktopHandoff.tsx`](../../src/components/DesktopHandoff.tsx) | [`../../src/utils/desktopDeepLink.ts`](../../src/utils/desktopDeepLink.ts) |
| Voice state in prompt UI | [`../../src/context/voice.tsx`](../../src/context/voice.tsx) | [`../../src/screens/REPL.tsx`](../../src/screens/REPL.tsx), prompt input components |

## Key Routing Decisions

- Reserved MCP server names are `claude-in-chrome` and `computer-use`; route
  server-name conflicts or wrapper bugs through their `common.ts`/`setup.ts`
  owners before touching generic MCP code.
- Chrome has two separate runtime pieces:
  the MCP server (`mcpServer.ts`) and the browser native messaging host
  (`chromeNativeHost.ts`). Do not treat them as the same process.
- Computer-use server startup and computer-use tool execution are split:
  `mcpServer.ts` owns tool listing and stdio server bootstrap, while
  `wrapper.tsx` owns actual call behavior.
- Voice availability is split across build flag, auth/gate visibility, command
  preflight, runtime audio capture, and WebSocket STT. Start in
  `voiceModeEnabled.ts` for visibility issues and in `voice.ts` or
  `voiceStreamSTT.ts` for runtime failures.
- Native installer work belongs under `src/utils/nativeInstaller/`; the repo
  no longer has a current `src/commands/install.tsx` owner surface, so do not
  route install/update work to that stale path.
- There is no repository-level `mobile/` client app folder here; mobile work in
  this repo is currently the `/mobile` command plus remote/mobile-safe message
  handling elsewhere.

## Tests And Validation

For docs-only refreshes:

```bash
git diff --check -- docs/maps/native-client-integrations.md
while IFS= read -r path; do test -e "$path" || echo "missing $path"; done <<'EOF'
src/commands.ts
src/main.tsx
src/entrypoints/cli.tsx
src/services/mcp/client.ts
src/commands/chrome/index.ts
src/commands/chrome/chrome.tsx
src/utils/claudeInChrome/setup.ts
src/utils/claudeInChrome/common.ts
src/utils/claudeInChrome/package.ts
src/utils/claudeInChrome/mcpServer.ts
src/utils/claudeInChrome/chromeNativeHost.ts
src/utils/claudeInChrome/toolRendering.tsx
src/utils/computerUse/gates.ts
src/utils/computerUse/setup.ts
src/utils/computerUse/mcpServer.ts
src/utils/computerUse/wrapper.tsx
src/utils/computerUse/executor.ts
src/commands/desktop/index.ts
src/commands/mobile/index.ts
src/commands/voice/index.ts
src/context/voice.tsx
src/services/voice.ts
src/services/voiceStreamSTT.ts
src/utils/nativeInstaller/installer.ts
src/native-ts
EOF
```

For code changes, scale verification by owner:

| Area | Focused verification route |
|---|---|
| Chrome setup/runtime | Chrome setup tests, manifest generation checks, and MCP client wrapping tests. |
| Computer-use | Gate tests, wrapper/lock tests, and macOS manual verification for native executor behavior. |
| Voice | Command preflight tests, audio fallback tests, and `voice_stream` transport tests. |
| Native installer | Installer/download/pid-lock tests plus build validation only if the code path changes. |
| Native TS shims | Caller-focused tests first: structured diff, file suggestions, or Ink layout. |

Docs-only map refreshes do not need `bun run build:dev:full`.
