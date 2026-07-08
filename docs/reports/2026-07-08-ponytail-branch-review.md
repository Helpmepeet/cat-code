# Over-Engineering Ledger — `main...migration`

**What this is.** A lazy-senior-dev over-engineering audit of the `main...migration` branch diff. Report-only: nothing here has been deleted or edited. Each item names a location, what to cut, and what replaces it.

**How it was run.** 20-shard parallel sweep (`find` over the diff, one shard per subsystem) produced candidate findings; every candidate was then put through a per-finding adversarial verify pass (skeptic tries to refute; killed findings dropped). What remains are the survivors, pre-ranked by `LOC × confidence` score.

**Headline number: ~148 deletable LOC across 19 surviving findings (16 confirmed, 3 downgraded).** _All 16 confirmed were subsequently execution-proven (applied at migration HEAD + battery green); measured net removal ~190 LOC. See the Execution verification section._

## Top 10 — delete this week

1. **`app/renderer/src/CommandPalette.tsx:281-306`** — cut the local `toneDotClass`/`toneTextClass` switch helpers (byte-for-byte dupes of the pair in `TabBar.tsx:360-384` and `Sidebar.tsx:575-599`) → export one `tabToneDot`/`tabToneText` next to `TabTone` in `tabStatus.ts` and import in all three (widen param to `TabTone | undefined`). **24 LOC · medium · confirmed.**
2. **`app/renderer/src/BannerStack.tsx:65-75`** — delete the `useBannerStack` imperative hook (zero callers; real consumer derives banners from pool status) → keep the pure tested `upsertBanner`/`dismissBanner`. **11 LOC · high · confirmed.**
3. **`app/main/navigationPolicy.ts:66-82`** — delete `decideWindowOpen` + `WindowOpenDecision` (its `action` discriminant is never read; `main.ts` hardcodes `{action:'deny'}`) → call `isSafeExternalUrl(url)` inline in the window-open handler. **18 LOC · medium · confirmed.**
4. **`app/renderer/src/workspaceLayout.ts:22`** — drop `focusedIndex` from `WorkspaceLayoutResult` + its 5 return sites (always equals `state.activeIndex`) → use `result.state.activeIndex` in `App.tsx`. **8 LOC · high · confirmed.**
5. **`src/services/api/codexAccountPool.ts:243-249`** — delete the `isPoolActive()` legacy alias (zero call sites; a bare `return canFailover()`) → `canFailover()`/`poolManagesCredentials()` already cover both uses. **7 LOC · high · confirmed.**
6. **`app/renderer/src/shellState.ts:192-197`** — delete the single-session `selectSession(state, sessionId)` selector (no production caller) → inline `state.byId[id] ?? null` if ever needed. **6 LOC · high · confirmed.**
7. **`app/scripts/harness-demo.ts:130-141`** — cut the `waitForServer` poll-fetch loop (near-verbatim of `dev.ts:48-61`) → extract/import one shared `waitForServer(url, timeoutMs)`. **10 LOC · medium · confirmed.**
8. **`app/scripts/run-f2-attach-smoke.ts:27-38`** — cut the copy-pasted `Bun.build` harness-bundle block (also in `run-hardening-smoke.ts:52-64`, `harness-demo.ts:39-51`) → one `bundleHarness(entry, opts)` helper. **15 LOC · low · downgraded** (harness-demo needs try/catch around a throw-helper; throwaway smoke scripts, low value). 
9. **`app/main/devHarness.ts:339-351`** — cut `atomicWriteJson0600` (third copy of tmp+fsync+rename) → export and reuse `registry.ts`'s `atomicWriteJson` (already 0600, strictly more robust), add the one `mkdirSync` at the dev-only call site. **13 LOC · low · confirmed.**
10. **`app/sidecar/index.ts:172-246`** — drop the `decoder` field from the `socketState` WeakMap entry (written on connect, never read; comment admits "unused… kept for clarity") → store just `{ connection }`, remove the `FrameDecoder` import. **3 LOC · high · confirmed.**

## Full ledger

### Renderer
| file:line | category | cut | replacement | LOC | conf | verdict |
|---|---|---|---|---|---|---|
| app/renderer/src/CommandPalette.tsx:281-306 | reinvented-stdlib | local `toneDotClass`/`toneTextClass` (dupes of TabBar/Sidebar) | shared `tabToneDot`/`tabToneText` in tabStatus.ts | 24 | medium | confirmed |
| app/renderer/src/BannerStack.tsx:65-75 | speculative-flexibility | `useBannerStack` hook (0 callers) | keep pure upsert/dismiss | 11 | high | confirmed |
| app/renderer/src/workspaceLayout.ts:22 | wrapper-no-invariant | `focusedIndex` field + 5 return sites | `result.state.activeIndex` | 8 | high | confirmed |
| app/renderer/src/shellState.ts:192-197 | dead-code | single-session `selectSession` selector | `state.byId[id] ?? null` inline | 6 | high | confirmed |
| app/renderer/src/SettingsShell.tsx:349-372 | one-caller-abstraction | `CategoryStub` wrapping single-caller `StubPanel` | fold into one component | 5 | low | downgraded |

### Sidecar
| file:line | category | cut | replacement | LOC | conf | verdict |
|---|---|---|---|---|---|---|
| app/sidecar/index.ts:172-246 | dead-code | `decoder` field on socketState entry (never read) | store `{ connection }`, drop FrameDecoder import | 3 | high | confirmed |
| app/sidecar/index.ts:21 | dead-code | unused `MAX_FRAME_BYTES` import | delete import line | 1 | high | confirmed |

### Account system
| file:line | category | cut | replacement | LOC | conf | verdict |
|---|---|---|---|---|---|---|
| src/services/api/codexAccountPool.ts:243-249 | dead-code | `isPoolActive()` legacy alias (0 callers) | canFailover / poolManagesCredentials | 7 | high | confirmed |
| src/services/api/codexIdentityReconciliation.ts:15 | duplicated-engine-machinery | private `countPoolStatuses()` (3rd copy) | export codexUsage.ts:521 version | 7 | low | confirmed |
| src/services/api/codexAccountPool.ts:1341-1346 | one-caller-abstraction | `getUsageHintObservationTime` one-liner (1 caller) | inline `getFiniteTimestamp(hint.fetchedAt) ?? now` | 5 | low | confirmed |
| src/codex-core/accounts.ts:226-228 | wrapper-no-invariant | local `isWithinRefreshSkew` pass-through | call imported `isWithinCodexRefreshSkew` at 3 sites | 3 | low | confirmed |
| src/services/api/client.ts:234 | speculative-flexibility | unused `profile` param on `toCoreAccount` | inline `account.alias ?? account.accountId` | 2 | high | confirmed |

### Electron main + preload + supervisor
| file:line | category | cut | replacement | LOC | conf | verdict |
|---|---|---|---|---|---|---|
| app/main/navigationPolicy.ts:66-82 | wrapper-no-invariant | `decideWindowOpen` + `WindowOpenDecision` (action never read) | inline `isSafeExternalUrl(url)` | 18 | medium | confirmed |
| app/main/devHarness.ts:339-351 | duplicated-engine-machinery | `atomicWriteJson0600` (3rd atomic-write copy) | reuse registry.ts `atomicWriteJson` | 13 | low | confirmed |
| app/supervisor/supervisor.ts:413-415 | dead-code | `socket.on('connect')` → setStatus('connecting') (no-op; already set at :406) | remove listener | 3 | high | confirmed |

### Engine settings + utils
| file:line | category | cut | replacement | LOC | conf | verdict |
|---|---|---|---|---|---|---|
| src/components/Settings/redeemResetMachine.ts:196 | speculative-flexibility | `windowsReset` field on RedeemResult 'success' (never read) | `{ kind: 'success' }`; drop carry-assertion test | 4 | medium | confirmed |
| src/components/Settings/redeemResetMachine.ts:191 | reinvented-stdlib | `mintRedeemRequestId()` wrapper (`return randomUUID()`) | inline `randomUUID()` at Reset.tsx:145,280 | 3 | low | downgraded |

### Scripts
| file:line | category | cut | replacement | LOC | conf | verdict |
|---|---|---|---|---|---|---|
| app/scripts/harness-demo.ts:130-141 | duplicated-engine-machinery | `waitForServer` poll loop (dupe of dev.ts:48-61) | shared `waitForServer(url, timeoutMs)` | 10 | medium | confirmed |
| app/scripts/run-f2-attach-smoke.ts:27-38 | duplicated-engine-machinery | `Bun.build` block (3 copies) | `bundleHarness(entry, opts)` helper | 15 | low | downgraded |

## Notes

- **Confirmed: 16 · Downgraded: 3** (run-f2-attach-smoke bundle block; SettingsShell `CategoryStub`; `mintRedeemRequestId` — all low-value/short-lived after verify). All 19 are survivors; nothing was killed post-verify in this synthesis.
- **Clean subsystems:** Host plane (durable registry / control-plane API) and Shared protocol (`app/shared/protocol.ts`, `hostApi.ts`) produced no surviving findings — the versioned wire contract and host boundary carried no over-engineering flags.
- **Method + caveats:** 20-shard find → single-vote adversarial verify per finding (no consensus vote), so residual false positives are possible on the low-confidence rows. LOC figures are approximate line counts, not mechanical diffs; several duplication cuts save net LOC only after adding one shared helper, and a few touch tests/doc references that must be swept alongside the code.

## Execution verification (apply-and-test, worktree-isolated)

After the read-based review, every one of the **16 confirmed findings was applied in an isolated git worktree at migration HEAD (`04faa91`) and run through its area battery** (app cuts: strict `app typecheck` — the whole-graph hidden-consumer catch — plus focused tests, plus `test:hardening` where security-adjacent; engine cuts: repo caller-grep plus colocated tests, since root tsc is known-red). **Result: 16/16 proven, 0 refuted.** No cut broke a typecheck, a test, or the hardening baseline. Confidence on all 16 is therefore **high (execution-proven)**, not reasoning-only. The 3 downgraded findings were not execution-verified (skipped as marginal-value by design).

Measured net removal across the 16 proven cuts: **~190 LOC** (real `git diff --stat`, higher than the read-review's ~148 estimate because several refactors also deleted now-dead tests and three duplicate helper copies).

| # | cut (proven) | battery | net LOC |
|---|---|---|---|
| 1 | `tabToneDot`/`tabToneText` dedup — CommandPalette/TabBar/Sidebar → tabStatus.ts | ✓app-typecheck · ✓tests | 47 |
| 2 | inline `decideWindowOpen` — navigationPolicy.ts + main.ts | ✓app-typecheck · ✓tests · ✓hardening | 48 |
| 3 | reuse `atomicWriteJson` — devHarness.ts + registry.ts | ✓app-typecheck · ✓tests · ✓hardening | 22 |
| 4 | delete `useBannerStack` hook — BannerStack.tsx | ✓app-typecheck · ✓tests | 12 |
| 5 | dedup `waitForServer` — harness-demo.ts + dev.ts | ✓app-typecheck · ✓tests | 10 |
| 6 | delete `isPoolActive()` — codexAccountPool.ts | ✓grep · ✓tests | 8 |
| 7 | dedup `countPoolStatuses` — codexIdentityReconciliation.ts | ✓tests · ✓grep | 8 |
| 8 | inline `getUsageHintObservationTime` — codexAccountPool.ts | ✓grep · ✓tests | 7 |
| 9 | drop `focusedIndex` — workspaceLayout.ts + App.tsx | ✓app-typecheck · ✓tests | 6 |
| 10 | drop write-only `windowsReset` — redeemResetMachine.ts | ✓tests · ✓grep | 5 |
| 11 | inline `isWithinRefreshSkew` — accounts.ts | ✓tests · ✓grep | 5 |
| 12 | delete no-op connect handler — supervisor.ts | ✓app-typecheck · ✓tests | 4 |
| 13 | drop unused `profile` param — client.ts | ✓grep · ✓tests | 3 |
| 14 | drop socketState `decoder` field — sidecar/index.ts | ✓app-typecheck · ✓typecheck · ✓tests · ✓hardening | 2 |
| 15 | delete `selectSession` selector — shellState.ts | ✓app-typecheck · ✓tests | 2 |
| 16 | delete unused `MAX_FRAME_BYTES` import — sidecar/index.ts | ✓app-typecheck · ✓typecheck | 1 |

**Verification caveat worth recording:** the first apply-and-test pass was half-compromised by a worktree bug — `isolation: worktree` could not check out the `migration` branch (already checked out in the primary tree), so agents landed on an ancestor commit lacking `app/`. App agents self-recovered by resetting the throwaway worktree to `04faa91`; the engine agents did not, producing 6 spurious 'inconclusive' verdicts and one **false 'refuted'** on `isPoolActive` (an agent on the ancestor commit saw 16 callers that do not exist at HEAD). Hand-grep of the live tree (zero non-test callers) plus a corrected re-run (reset-to-HEAD baked in) confirmed all 7 as proven. Lesson: worktree isolation needs an explicit `git reset --hard <branch HEAD>` when the target branch is already checked out elsewhere.

## Appendix — findings killed by verify (7)

These candidates were raised by a finder and then **refuted** by the per-finding skeptic. They are recorded here as an audit trail — they are NOT recommended cuts. Most collided with the do-not-flag list or with a documented deferral in `PROGRAM-PLAN.md` / `PARITY-LEDGER.md`, which is exactly what the verify pass exists to catch.

| proposed location | category | what the finder wanted to cut | why the skeptic killed it |
|---|---|---|---|
| `app/sidecar/sidecarServer.ts:1363-1385` | reinvented-stdlib | Delete the hand-rolled recursive deepEqual helper used only by sanitizePermissionResponse's T6 echo check. | The helper's sole use (sidecarServer.ts:763) is the T6 updatedInput echo-only check — on the do-not-flag security baseline. The swap isn't equivalent either: Bun.deepEquals defaults to non-strict (treats {x:undefined} == {}), while the current impl enforces exact key-count/key-presence equality — loosening a security-boundary echo check. |
| `app/renderer/src/transcriptProjector.ts:222-223,237-238` | speculative-flexibility | Delete the SnipBoundaryRow and TombstoneRow types and their two entries in the TranscriptRow union — nothing anywhere mints a row with kind 'snip-boundary' or ' | SnipBoundaryRow/TombstoneRow are a documented, deliberately-deferred prototype-parity placeholder, not speculative flexibility: the seam-gap report (docs/migration/reviews/2026-07-04-p2-1-transcript-seam-gaps.md), STATUS.md:84, PARITY-LEDGER.md:375-376, and INVENTORY.md:58 all record them as "typed but unminted, cut pending an engine SDK seam change (documented, not silent)." The engine already em |
| `app/renderer/src/agentIdentity.ts:246-253` | dead-code | The exported DROPPED_PROTOTYPE_AGENT_IDENTITY_FIELDS constant — a static list of 6 doc strings naming prototype fields that were dropped — plus its only consume | The const is a deliberately-designed parity guardrail, not accidental dead code. PARITY-LEDGER.md:978 records it as "the anti-silent-drop instrument" enforcing CLAUDE.md rule #9 (silent parity cuts are a named recurring mistake), and it's cited in the P4 tranche-A review (docs/migration/reviews/2026-07-07-p4-tranche-a-review.md:90). It IS also tracked in the parity ledger as the reviewer suggests; |
| `app/renderer/src/settingsState.ts:75-81` | speculative-flexibility | selectSettingField selector (and its SettingResolution export at line 59) — described as 'the lookup every Field in a panel makes', but the landed panels (Setti | The finding wrongly bundles SettingResolution (line 59), which is NOT dead — it is the return type of selectManagedFields at settingsState.ts:98 (SettingResolution[]), a selector the landed panels do call — so the "8 LOC" cut is inflated to only ~7 lines of the selector itself. More decisively, selectSettingField is not speculative: it is exercised by settingsState.test.ts:81-93 and STATUS.md:219  |
| `app/host/registry.ts:261-272` | speculative-flexibility | The Windows PowerShell Get-CimInstance branch in defaultProcessCommand — speculative cross-platform support in a module whose comments repeatedly state it is PO | The engine broadly and actively supports Windows (20+ `win32` branches across src/ink/, src/main.tsx, src/skills/, src/utils/deepLink/), and this is an Electron desktop app for which Windows is a plausible target — the module comment "POSIX-first like the engine" means POSIX-primary-but-Windows-handled, matching the engine's own posture. On Windows `ps -o command= -p ` doesn't exist, so the win32  |
| `app/host/registry.ts:645-664` | dead-code | The setTitle() and touchAttached() write-point methods have no production caller (host.ts sets title only via upsertOnSpawn at spawn; nothing calls a rename or  | setTitle is an explicitly designed registry write point — phase3.md:339 lists the durable-registry write points as "upsert on spawn, engineSessionId fill on ready, title on rename, ..." and the code doc-comments cite §4.5 for exactly these. phase4.md:479/496 plans a per-session rename action that "maps to real operations", the concrete future caller. The methods are part of the locked host-plane d |
| `app/main/replayBuffer.ts:114-121` | dead-code | isReplayTruncationFrame is exported but has no production consumer — grep shows it is referenced only by three .test.ts files; the truncation frame is a normal  | isReplayTruncationFrame is a shared test-assertion helper with three real consumers (app/main/replayBuffer.test.ts, attachmentGate.test.ts, historyReplayReload.test.ts), all asserting the truncation-frame identity minted by replayTruncationFrame in the same file. The proposed inline would duplicate the kind==='error' && requestId===REPLAY_TRUNCATION_REQUEST_ID check across three files, worsening n |

_Run metadata: 20 finder shards (opus, effort high) → dedup → 26 candidates → one skeptic per finding (opus, effort low, refute-by-default) → 19 survivors / 7 killed → 1 synthesizer. 47 agents, 0 errors, ~2.05M subagent tokens, ~5.7 min wall-clock. Report-only; no code changed._
