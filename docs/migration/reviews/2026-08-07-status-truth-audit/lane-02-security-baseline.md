# Lane 02 — The security baseline, as actually enforced

**Auditor verdict:** RED
**Rows audited:** 3 · TRUE 1 · OVERSTATED 1 · FALSE 0 · STALE 1 · UNVERIFIABLE-HEADLESS 0

Scope: STATUS row P0-5, plus the two program-wide standing claims this lane owns —
"the security baseline is intact" (CLAUDE.md §5, `.claude/rules/migration.md`) and
STATUS's repeated assertion that `bypassPermissions` is rejected at the boundary.

Battery run (once, as authorised): `bun run --cwd app test:hardening` →
**19/19 passed**, "production path passed". Every check green, including
`bridge exposes exactly the allowlisted methods`, `raw ipcRenderer is not exposed`,
CSP blocked inline script + inline `onerror`, `will-navigate` blocked a non-app
document, window-open handler denied a new Electron window.

---

## Row verdicts

### P0-5 — Boundary-security minimum (threat model · IPC allowlist · secret owner)
**Verdict:** TRUE

**Claims checked:**
1. A renderer threat model was produced (T1–T7).
2. A default-deny IPC allowlist was specified — 4 message types, no raw
   command/FS passthrough, no self-approval.
3. Secret owner = engine only (`auth.ts`, `codex-core/accounts.ts`); renderer
   sees redacted status.
4. Renderer hardening was written as P1-0 acceptance criteria.
5. Three real source holes were flagged for P1-0: `goalSnapshot` `z.unknown()`
   (T4), `updatedInput` command-rewrite on allow (T6), no length caps (T7).
6. "Orchestrator scrutinized doc + re-verified T4/T5a/T6 anchors."

**Evidence:** `docs/migration/decisions/SECURITY-MINIMUM.md:17-101` (threat model),
`:103-146` (allowlist + R1–R5), `:150-201` (P1-0 checklist), `:205-235` (secret
owner), `:239-252` (anchor appendix). The row is a **SPEC** row, and the doc it
points at is exactly what the row describes. All three flagged holes are real in
the engine today and all three are closed in `app/`:
- T4 hole still exists upstream: `src/web/appSessionProtocol.ts:21`
  `goalSnapshot: z.unknown().optional()`; it is closed at the sidecar by
  `app/sidecar/sidecarServer.ts:1433-1457` (`parseThreadGoal`, reject on invalid).
- T6 hole still exists upstream:
  `src/utils/permissions/PermissionPromptToolResultSchema.ts:47` and `:110-111`
  (non-empty `updatedInput` replaces the tool input); closed by
  `sidecarServer.ts:2397-2427` (echo-only, and the GATED input is what is
  forwarded, so an empty `{}` cannot mean "use original").
- T7 caps now exist: `app/shared/limits.ts:20,29,32,39,53,56`.

**Reachable-path trace:** renderer `window.catcode.*` (`app/preload/preload.ts:87-365`)
→ fixed Electron channel → `app/main/main.ts:937-1201` (per-channel type pinning)
→ supervisor → socket → `sidecarServer.handleFrame` (`:836-1033`) → engine.

**Anchor drift:** the doc pins itself to engine commit `234da9e` and says so
(`SECURITY-MINIMUM.md:3,12`), so drift against today's `src/` is disclosed, not
hidden. Measured anyway: `appSessionProtocol.ts:21` **exact**;
`PermissionPromptToolResultSchema.ts:47` and `:110-111` **exact**;
`AppSessionController.ts:142-143` → actual `:151`; `:189` → actual `:199`;
`:91-96` → actual `:95-100`. Nit, not a finding.

---

### Standing claim — "the security baseline is intact on every `app/` change"
**Verdict:** OVERSTATED

Nine of the ten controls in this lane's contract are enforced at the sidecar and
carry rejecting boundary tests. One decided control has been deleted.

**1. Inbound vocabulary is a closed allowlist validated at the sidecar — HOLDS.**
`checkStrictKeys` (`app/sidecar/sidecarServer.ts:3480-3611`) runs **first**, before
any dispatch branch (called at `:872`, ahead of every `if` at `:884-1015` and ahead
of the shared Zod parse at `:1020`). It is a `Map` of type → exact key set and
returns `unknown message type: <t>` for anything absent (`:3574-3577`), and uses
`Map.get` rather than `in` so `constructor`/`toString` cannot be treated as a type
(tested, `sidecarServer.test.ts:3590`). Fail-closed by construction: a frame kind
added to `protocol.ts` but not to this map is rejected, it does not leak through.

I enumerated every inbound kind in `app/shared/protocol.ts` (`SidecarClientMessage`,
`:474-487`) and cross-checked all **30** against the map and against a validating
handler. Every one is covered:

| Kind | Sidecar schema | Rejecting test |
|---|---|---|
| `app.submit` / `app.abort` / `permission.response` / `app.ping` | `appClientMessageSchema` (`:1020`) + per-field caps (`:1042`, `:1055`, `:1421`) | `sidecarServer.test.ts:310,327,335,381,1448,3454,3468,3486` |
| `permission.setMode` | `permissionSetModeMessageSchema` (`:3620`, parsed `:1660`) | `:4015`, `:4039` |
| `askUserQuestion.answer` | `askUserQuestionAnswerMessageSchema` (`:3656`, parsed `:2452`) | `:3148,3176,3184,3401,3416,3434` |
| `account.*` (9 verbs) | `accountVerbMessageSchema` (`:3675`, parsed `:1711`) | `:4295,4311,4327,4481,4542,4703` |
| `workspace.trust` | `workspaceTrustMessageSchema` (`:3733`, parsed `:1790`) | `:5667,5699` |
| `agent-mode.set` | `agentModeSetMessageSchema` (`:3764`, parsed `:1841`) | `:1812,1831,1850` |
| `task.stop` | `taskControlVerbMessageSchema` (`:3779`, parsed `:1902`) | `:1969,1988,2007` |
| `model.set` / `effort.set` / `fast.set` | `runControlVerbMessageSchema` (`:3794`, parsed `:1957`) | `:2462,2481,2500,2519` |
| `session.rename` / `.export` / `.branch` / `.tag` | `sessionActionVerbMessageSchema` (`:3821`, parsed `:2028`) | `:6086,6108,6131,6154,6232,6255` |
| `remoteSettings.bridgeToggle` / `.directConnect` | `remoteVerbMessageSchema` (`:3897`, parsed `:2153`) | `:4878,4940,4966` |
| `settings.setValue` | `settingsVerbMessageSchema` (`:3933`, parsed `:2221`) + `EDITABLE_SETTINGS` | `:5090,5114,5141,5354` |
| `context-breakdown.request` | `contextBreakdownMessageSchema` (`:3752`, parsed `:2992`) | `contextBreakdownBoundary.test.ts:160,188` |
| `app.park` | `appParkMessageSchema` (`:3633`, parsed `:1557`) | `:552,570` |

No frame kind reaches a handler unvalidated. A negative test exists that the
surface has not silently grown: `:6490` "the inbound allowlist did NOT grow: a
lease verb is rejected bad_request".

Main does not permit cross-channel type smuggling either: each `ipcMain.on`
re-pins the type against its own `*_VERB_TYPES` constant before forwarding
(`main.ts:1030,1050,1088,1108,1130,1151,1170,1190`), and `app.park` has no preload
channel at all.

**2. T4 `goalSnapshot` schema-validated — HOLDS.** `sidecarServer.ts:1433-1457`;
a present-but-invalid snapshot is `bad_request`, and a mid-turn submit carrying one
is refused rather than silently stripped (`:1491`+, tested `:1200`, `:1448`).

**3. T5a engine-minted request id — HOLDS.** `sidecarServer.ts:2295-2307` looks the
id up in `controller.getPendingPermissionRequests()`
(`src/app-runtime/AppSessionController.ts:85-87`) and answers
`permission_not_found` on a miss. The same lookup guards the C5 answer frame
(`:2467-2479`). No inbound frame can register or pre-seed a pending request
(R3 preserved — the allowlist above has no such verb).

**4. T6 `updatedInput` echo-only — HOLDS, and stronger than the spec.**
`sanitizePermissionResponse` (`:2397-2427`) accepts the renderer's `updatedInput`
only when empty or deep-equal to the gated input, then forwards
`extractGatedToolInput(request)` — the engine's own bytes — so even the empty-`{}`
"use original" reversal is closed. Tested `:2577,2608,2638`.

**5. T6b + C1 selection-by-index — HOLDS exactly as decided.**
`updatedPermissions` is rejected as a key at `:3561-3566` and stripped as a
backstop at `:2390-2395`. `validateSuggestionSelection` (`:4033-4090`) enforces all
five C1 conditions (array-or-absent, allow-only, ≤ `MAX_SUGGESTION_SELECTIONS`,
request actually minted suggestions, integer + in-range + no duplicates), and
`:2341-2344` attaches `structuredClone(selection.updates)` taken from the pending
request, never from the wire. Tested `:2671,2714,2762-2967`. No renderer module
constructs `updatedPermissions` (`rg updatedPermissions app/renderer/src` → zero
non-test hits).

**6. T7 size / rate / prompt caps — HOLD.** Frame cap at decode
(`app/shared/framing.ts:50-58`), rate cap per connection
(`sidecarServer.ts:3409-3417`, called `:789`), prompt cap in UTF-8 bytes
(`:1421-1431`), free-text caps (`:1042`, `:1055`), and a queue **depth** cap
(`:1481`, `MAX_QUEUED_PROMPTS`) that closes the accumulation hole the mid-turn
queueing opened.

**7. Directional limits never swapped — HOLD.** Checked every use site:
sidecar inbound decoder `MAX_FRAME_BYTES` (`sidecarServer.ts:580`); sidecar
outbound bound `MAX_OUTBOUND_FRAME_BYTES` (`:3363`); supervisor decoder for the
sidecar→main direction `MAX_OUTBOUND_FRAME_BYTES` (`supervisor.ts:279`);
supervisor's write toward the sidecar checks `MAX_FRAME_BYTES` (`:349`); preload
guard uses `MAX_FRAME_BYTES` (`rendererIpcGuard.ts:30`). `saveTextToFile` correctly
takes a third cap (`MAX_SAVE_TEXT_BYTES`) rather than reusing or moving either
(`limits.ts:58-81`, enforced at main via `validateSaveTextRequest`,
`main.ts:1500`).

**8. `secretGuard` on outbound, unbypassable — HOLDS.** `send`
(`sidecarServer.ts:3326-3347`) scans every frame except `error`, and `send` is the
single write path (only `encodeFrame`/`socket.write` pair in `app/sidecar` is
`:3351`/`:3371`). The `error` exemption is compensated: `sendError` redacts
absolute paths and bounds length (`:3459-3468`, tested `:413,439`). The guard fails
closed past `MAX_DEPTH` (`secretGuard.ts:72-76`).

**9. Preload default-deny; renderer sees no raw credentials — HOLDS.**
`preload.ts:51-84` are fixed channel constants; every exposed method sends a
structured payload on a constant channel (`:87-355`); no `require`/`fs`/`process`/
`child_process` and no raw `ipcRenderer` in the exposed object. Confirmed live by
the hardening smoke (`window.require/process/module/global` undefined, "bridge
exposes exactly the allowlisted methods"). `rg -i 'accessToken|refreshToken|apiKey|
vaultFilePath' app/renderer/src` → one hit, `apiKeySource` in a fixture, an enum
label not material. HC1/HC4 also intact: `pickDirectory` returns a one-time cwd
token not a path (`preload.ts:252-257`), and `MAX_LIVE_SESSIONS` + a spawn-rate cap
are enforced in the host (`app/host/host.ts:717-727`).

**10. `bypassPermissions` grantable only from a trusted launch surface — BROKEN.**
See F1. This is the one control in the contract that is no longer enforced, and it
is why this row is OVERSTATED rather than TRUE.

---

### STATUS §P2-4 / STATUS:111 — "`bypassPermissions` rejected at the boundary"
**Verdict:** STALE

**Claims checked:** STATUS:111 ("C2 = `permission.setMode` inbound frame, session
destination only, `bypassPermissions` rejected at the boundary") and the P2-4 row
(STATUS:119) which records the operator's live 8/8 verification of that C2
behavior.

**Evidence:** true when written. Broken by commit **`b74b583`** (2026-08-06,
"fix(app): deliver a mid-response message to the running turn, not the next one"),
which deleted the gate from `handleSetMode`. The removed block, recoverable with
`git show b74b583 -- app/sidecar/sidecarServer.ts`, was:

```
-    if (
-      raw.mode === 'bypassPermissions' &&
-      this.permissions?.getToolPermissionContext()
-        .isBypassPermissionsModeAvailable !== true
-    ) { … 'mode "bypassPermissions" is not available (launch with CATCODE_ALLOW_BYPASS=1)' … }
```

Today `handleSetMode` (`sidecarServer.ts:1639-1694`) gates only `auto`
(`:1646-1658`). `bypassPermissions` is on the wire allowlist
(`protocol.ts:105`), passes `checkStrictKeys`, passes the Zod enum, and is applied.
The replacement tests state the new behavior plainly:
`sidecarServer.test.ts:3883` — *"C2 — bypassPermissions is available without a
launch flag"*, asserting no error frame and
`store.getState().toolPermissionContext.mode === 'bypassPermissions'` on a store
where `isBypassPermissionsModeAvailable` is unset.

**Anchor drift (separate, Low):** `decisions/PERMISSION-BOUNDARY.md` §2 cites
`sidecarServer.ts:492-554` for `handlePermissionResponse` (actual `2285-2347`),
`:979-1036` for `validateSuggestionSelection` (actual `4033-4090`), `:855-860` for
the response key allowlist (actual `3561-3566`), `:598-602` for the sanitizer
backstop (actual `2379-2428`). Unlike SECURITY-MINIMUM, this doc pins no commit —
it says "all anchors re-verified against the working tree on 2026-07-03" — so a
reader has no signal that the anchors are ~1,800 lines stale. The described
behavior is still correct; only the line numbers rotted.

---

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | **Critical** | Standing baseline claim / P2-4 | The `bypassPermissions` trusted-launch gate — a DECIDED control (`PERMISSION-BOUNDARY.md:16,196-212,383-384`) mirroring the CLI's `--dangerously-skip-permissions` — was deleted at the sidecar. The boundary now accepts `permission.setMode{mode:'bypassPermissions'}` unconditionally; the only remaining gate at HEAD is a `disabled` attribute in the renderer, which SECURITY-MINIMUM R2 (`:136-138`) explicitly classifies as UX, not security. | Gate removed in `b74b583`; current `app/sidecar/sidecarServer.ts:1639-1694` gates only `auto`. Wire allowlist `app/shared/protocol.ts:99-106`. Renderer-only gate at HEAD `app/renderer/src/PermissionModeChip.tsx:191-195` (and a concurrent session is removing even that — the working-tree copy at the same lines drops the `isBypassPermissionsModeAvailable` clause). | A T1-compromised renderer (injected script in rendered Markdown, the threat the whole boundary exists to stop) sends one `setPermissionMode(sessionId,'bypassPermissions')` call through the preload bridge. Every subsequent tool call in that session runs with no permission prompt and no permission round-trip — no audit trail, no human in the loop, for `Bash`, `FileWrite`, `FileEdit`. Previously this required a `CATCODE_ALLOW_BYPASS=1` launch, which a renderer cannot forge. |
| F2 | **High** | Standing baseline claim | The removal was undisclosed. `b74b583`'s body asserts *"No new frame kind, preload channel, inbound vocabulary or error code"* — literally true about additions, while an inbound **policy** control and its error were deleted in the same commit. No STATUS row, no `§0` deviation flag, no decision-doc amendment. `PERMISSION-BOUNDARY.md` and STATUS:111 still assert the gate as current. | `git show b74b583 --format=%b`; `docs/migration/decisions/PERMISSION-BOUNDARY.md:16,199,383-384`; `docs/migration/STATUS.md:111`. | A future session reads the decision doc (which CLAUDE.md §5 and `.claude/rules/migration.md` both route to as authoritative), builds on "bypass is boundary-rejected", and ships a feature whose safety argument rests on a control that no longer exists. This is the "reopening a locked decision silently" failure mode, executed as a comment edit inside an unrelated fix. |
| F3 | Medium | Standing baseline claim | `protocol.ts:91-92` and `:2795-2797` justify the removal with "the engine's own bypass killswitch remains authoritative". I could not find that killswitch on this path. `permissionDomain.setMode` (`app/sidecar/permissionDomain.ts:92-112`) calls `transitionPermissionMode` (`src/utils/permissions/permissionSetup.ts:597-640`), which handles plan/auto transitions and throws only for the **auto** gate; it never consults `src/utils/permissions/bypassPermissionsKillswitch.ts`. The `disableBypassPermissionsMode` check that does exist (`permissionSetup.ts:802`) is on a different path. | `permissionDomain.ts:92-112`, `permissionSetup.ts:597-640`, `permissionSetup.ts:802`. | The stated compensating control for F1 does not fire on the desktop mode-switch path, so the removal is uncompensated rather than merely relocated. If it does fire somewhere I did not find, it is at minimum uncited — see Uncertainties. |
| F4 | Low | P2-4 / decision doc | Anchor drift in `PERMISSION-BOUNDARY.md` §2: four cited `sidecarServer.ts` ranges are ~1,800 lines stale and the doc pins no commit, unlike SECURITY-MINIMUM which pins `234da9e`. | `PERMISSION-BOUNDARY.md` §2 vs `sidecarServer.ts:2285,3561,2379,4033`. | A session following the doc's line numbers lands in unrelated code and either re-implements an existing control or edits the wrong one. |
| F5 | Low | (user-visible text) | At HEAD the bypass menu item's tooltip reads "Bypass mode has to be turned on when Cat Code starts. Enable it from the command line, then open a new session." That instruction is now false — the sidecar accepts the mode with no launch flag. | `app/renderer/src/PermissionModeChip.tsx:206-207` (HEAD). | A user follows the instruction and restarts with a flag that no longer does anything. Note: a concurrent session's working-tree edit deletes this string, so it may self-resolve. |

**Uncertainties.** F1's *intent* is genuinely unclear and I did not resolve it.
The change is coherent enough to look deliberate (protocol comments were rewritten,
tests were rewritten to assert the new behavior, and a concurrent session is right
now aligning the renderer to match), and "bypass in the mode picker" is plausible
prototype parity. What I could not find is any record that the operator ruled on
it: no STATUS row, no decision amendment, no `§0` flag, no commit message
mentioning it. So F1 may be an approved product decision with missing paperwork, or
an unnoticed security regression. **What would resolve it:** the operator says
whether they asked for bypass in the desktop mode picker. If yes, F1 collapses to
F2 (record the decision, amend `PERMISSION-BOUNDARY.md` §3 and STATUS:111, and
close F3 by either citing or building a real engine-side gate). If no, the deleted
block should be restored.

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)
None. Every claim in this lane was settled from source plus the hardening smoke.

## Nits
- `SECURITY-MINIMUM.md` anchor appendix is 8-10 lines off on three
  `AppSessionController.ts` citations, but the doc pins engine commit `234da9e`
  and says source wins, so this is disclosed drift rather than a defect.
- `handleContextBreakdownRequest` (`sidecarServer.ts:2991-2996`) rejects silently
  rather than with an error frame. Deliberate and documented at `:2987-2989`
  (read-only refresh, no user-visible commitment); noting only because it is the
  one inbound kind that does not answer a rejection.
- `sidecarServer.ts` is now 4,262 lines with the boundary logic spread from `:836`
  to `:4090`. Not a defect, but it is why every decision-doc anchor into it has
  rotted.
