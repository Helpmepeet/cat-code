# Clickable created-peer row

Date: 2026-09-15
Status: implemented 2026-09-15; focused headless validation complete. Cat Code Dev visual
comparison remains for the operator.

## Request

Make the existing peer-creation row inside the conversation clickable so the user can open the newly created session. Reuse the existing row rather than append a second confirmation card. This covers `CreatePeer`, not user-created sessions, subagents, or other peer tools.

Visual artifact: [created-peer row mockup](../design-html/2026-09-15-created-peer-session-link.html). The HTML is an intentionally untracked local review artifact, not a product entrypoint. Its navigation buttons only update a neutral destination label; they do not open real sessions. Sample name and prompt are generic.

## Existing behavior and constraints

- [`peerToolPresentation`](../../app/renderer/src/peerSurfaces.ts) gives `CreatePeer` the existing `+` mark, `Peer` family word, and shared peer hue.
- Before this implementation, [`derivePeerTargetParts`](../../app/renderer/src/TranscriptView.tsx) took the creation header from `input.prompt`, including a 160-character cap, and did not read the returned name.
- The ordinary [`ToolCardShell`](../../app/renderer/src/TranscriptView.tsx) makes the whole header a disclosure button. The dot reports tool-call status, not the created session's activity.
- [`toolCardStyle.ts`](../../app/renderer/src/toolCardStyle.ts) already supports Cards and Lines. The proposal preserves both, including the existing fonts, colors, shell, and density from [`theme.css`](../../app/renderer/src/theme.css).
- [`peerRequestPlane.ts`](../../app/main/peerRequestPlane.ts) returns `name`, `appSessionId`, and an optional `failedStep` for `peer.create`. [`HostRequestValues`](../../app/shared/protocol.ts) includes those fields, and [`narrowCreatedPeer`](../../app/sidecar/createPeerTool.ts) retains the validated ID in successful output.
- [`projectToolResultBlock`](../../app/renderer/src/transcriptProjector.ts) reads the structured `tool_use_result` alongside display text and projects validated created-peer destination facts.
- [`SessionDescriptor`](../../app/shared/hostApi.ts) explicitly documents that names can be reused after registry reaping, while application session IDs are not reused. Never reconstruct a historical destination from a name.
- [`App.tsx`](../../app/renderer/src/App.tsx) owns navigation: `selectTab` focuses an existing session and respects split panels; `applyOpenRoute` and `resolveSessionOpenRoute` share the live/restore/history decision. `performRestore` prefers transcript preview but may restore the session when no preview exists. Clicking is an explicit user navigation action; rendering must not trigger this path.

## Visual and interaction decision

Keep one compact row. Once a confirmed destination is available:

```text
+ PEER   Bear · Check the example tests                 ● Open → | Details ⌄
```

- The name is the strongest text in the target slot. The original prompt remains secondary and truncates first. Do not substitute a changing session title for the recorded creation instruction.
- The main area, including `Open →`, is a single navigation button. It opens/focuses that session in the existing workspace, not a new window or duplicate tab. It never auto-switches when creation finishes.
- A sibling Details button expands the original creation prompt and result in place. Do not put one button inside another. Disclosure never also navigates, and navigation never toggles disclosure.
- Keep `+ Peer` in the existing peer hue, with ordinary primary text for the name. No new accent, avatar, colored tile, separate success card, model badge, or live activity feed.
- Retain the success dot as the creation outcome, with accessible text `Session created`; it must not imply that the peer finished its assignment. No idle/running/completion status is inferred from creation.
- Reuse the existing Cards/Lines preference and expansion memory keyed by `toolUseId`. Honor the expanded-tools preference. No new preference is needed.
- The HTML's light appearance uses real theme tokens. Pending motion is frozen in the mock; the implementation should preserve the existing pending indicator and reduced-motion behavior.

### States

| Situation | Presentation and action |
| --- | --- |
| Pending, no confirmed destination | Existing prompt row, `Creating…`, pending dot, disclosure only. No name or open action invented. |
| Created, instruction delivered | Name + prompt, success dot, Open and separate Details. |
| Created, readiness timed out | Still link to the created ID. Warning dot and a short note that it did not finish starting and has not received the instruction. Do not call this a failure to create. |
| Created, instruction delivery failed | Still link to the created ID. Warning dot and `Session created. The instruction did not reach it.` Preserve the full result in Details. |
| Creation failed or outcome uncertain | No destination button. Preserve the actual error and existing error disclosure behavior. A timeout does not prove that no session was created; do not offer automatic retry. The mock shows this timeout example. |
| Created target is no longer available | Keep the historical name and prompt. Replace Open with `Unavailable`; the row still discloses its details. Do not resolve a replacement by name. |
| Target closed/parked but restorable | Keep Open and use existing session-open routing. Do not mark a restorable target unavailable just because no live process exists. |
| Old or malformed result without a valid recorded ID | Keep the ordinary tool row and readable result, with no navigation affordance. No migration or prose parsing. |
| Cancelled tool call | Preserve existing cancellation rendering. Do not invent a destination or treat cancellation as proof the host never created anything. |

Use visible warning text for the partial outcomes, not hue alone. For failures, preserve truthful producer text rather than classifying outcomes by matching English sentences. Distinguishing additional failure subtypes is not required for this feature.

## Implementation

### 1. Preserve destination identity through the existing result

In `app/sidecar/createPeerTool.ts`, retain and runtime-narrow the host-returned `appSessionId` in successful `CreatePeerOutput`, including both partial-success branches. Keep the model-facing result prose and the tool's input schema unchanged. The ID belongs in structured result data, not in a prompt or a renderer-authored create request.

The host response already carries the ID, so do not introduce another IPC method, a registry lookup endpoint, or a new wire frame. Confirm the existing structured-result persistence paths for Claude and Codex carry the retained field through live delivery and history replay. Use real engine frame fixtures, not a mock-only result shape. If an actual wire shape must change, revisit protocol compatibility and its required versioning before implementing that change.

### 2. Project bounded creation facts

Extend `ToolResultProjection` in `app/renderer/src/transcriptProjector.ts` with optional created-peer facts: recorded name, application session ID, and recognized failed step. Runtime-narrow unknown values; reject empty/malformed identity and prevent an unknown outcome from looking like fully successful delivery. Only the matching `CreatePeer` row may consume these facts as a navigation target.

Preserve existing `tool_use_id` correlation, immutable producer rows, duplicate-frame handling, and out-of-order live/history behavior. Derive the new rendering at read time. Do not parse `Created Bear ...` strings or join current descriptors by peer name.

### 3. Connect to the shell's existing navigation

Pass a narrow session-target availability/navigation capability from `App` through `SessionPane` into the transcript using the existing prop/context conventions. Keep route selection in the shell rather than copying restore logic into `TranscriptView`.

Resolve the recorded application session ID against the current shell/catalog state and reuse `resolveSessionOpenRoute`/`applyOpenRoute` where applicable. Revalidate at click time, including a target disappearing between render and click. If the host snapshot has not arrived yet, do not permanently mark a target missing; let read-time state update it. Do not issue roster requests, restore processes, or poll because a row is visible.

Focus a target already present in another split panel instead of duplicating it. Preserve the source session's in-flight work, draft, transcript scroll memory, and tool expansion state through the normal tab/panel navigation path. A missing target must fail visibly without redirecting to a same-named session.

### 4. Specialize only the creation row

Add a small `CreatePeer` rendering branch in `TranscriptView.tsx`, before the ordinary peer tool-card fallback, while preserving the cancellation branch. Share existing shell tokens and `useToolCardExpanded`; do not refactor all tool cards to accommodate one new action.

Use sibling native buttons for Open and Details. Give them specific accessible names such as `Open session Bear` and `Show creation details for Bear`; disclosure has `aria-expanded` and `aria-controls`. Retain visible focus treatment, keyboard Enter/Space behavior, and usable controls at narrow widths. In the target slot, protect the name from a long prompt; allow the name itself to truncate only when necessary at very narrow widths. Keep all shipping styling in classes/stylesheets, with any non-component helpers in `.ts` modules.

Continue to expose the complete input/result through the existing details/inspector path. Do not lose error output, copyability, or nested tool-row behavior. Never append a second row on completion.

### 5. Tests and documentation

Change the existing test claiming a finished create can only show its instruction: retain that expectation for pending and legacy results, and add confirmed-destination coverage. Update the relevant peer-surface decision text only where behavior changes, and refresh navigation maps if new ownership seams are added. Search all source, imports, tests, docs, configuration, Markdown and YAML for stale claims about the create header and click behavior before declaring implementation complete.

## Verification and acceptance

Focused regression coverage:

- Sidecar result preserves the exact host ID for full success and both failed steps; malformed identities are rejected, not turned into links.
- Real structured results survive live SDK projection and history replay for both provider paths; duplicate/reordered frames still produce one row and one destination.
- Pending, error, cancelled, legacy and malformed results never open an invented session. Two simultaneous creates keep their destinations correlated by tool-use ID.
- Open routes by immutable ID. Reaping the original and reusing its name cannot open the new session.
- Live, parked/restorable, unavailable and not-yet-observed descriptors behave correctly. Clicking a target already shown in another panel focuses it without duplication.
- Open does not expand Details; Details does not navigate. Both work with keyboard controls, Cards/Lines, tools-expanded mode, narrow widths and long prompts.
- Partial success remains navigable but never reports delivered instructions. A successful creation never reads as completed peer work.
- Tab round-trip preserves the creator's draft, stream, scroll position and disclosure state.

Run focused tests first, including affected `createPeerTool`, `transcriptProjector`, `TranscriptView`, navigation and style tests. Because implementation crosses the sidecar/renderer boundary, also run `bun test app/`, `bun run --cwd app typecheck`, `bun run --cwd app typecheck:sidecar`, and `bun run --cwd app renderer:build`. If shared engine producer code is changed, include the affected engine tests and `bun run build:dev:full`. Run `git diff --check`, `bun run maps:lint`, and verify changed links.

Real app acceptance requires separately authorized Cat Code Dev GUI work under [GUI-VERIFICATION.md](../migration/process/GUI-VERIFICATION.md): create a peer using isolated/authorized state; click its row; confirm the matching tab is focused; return and inspect Details; test a restorable target and the split-panel case. A real peer creation can consume model quota, so neither this design task nor the static mock authorizes it. Run `test:hardening` if implementation affects the desktop security/runtime integration boundary, with authorization for its Electron launch. Static HTML and DOM checks alone do not prove production navigation.

## Out of scope

This implementation does not add automatic tab switching, session creation from the card, lifecycle control, session retry, live peer status, clickable prose/name matching, sidebar redesign, or expansion to other peer tools. It makes no format migration and preserves saved sessions.
