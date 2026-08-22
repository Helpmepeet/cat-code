# Cold review — the worker-face series (`9cffc927..e4193041`)

**Date:** 2026-08-22 · **Reviewer:** an orchestrator session with seven read-only review
lanes · **Range:** `9cffc927..e4193041`, 5 commits, 18 files, ~2,577 diff lines.

Not the reviewed session's own work. Every finding below was re-verified against source by
the orchestrator before being written down; where a lane's claim did not survive that check
it is marked as corrected rather than dropped, because the correction is the useful part.

## Outcome first

The face algorithm is the strongest part of the series and no finding touches it. Shape
identity survives 400 workers, the alias/owner handshake in `faceFor` correctly reconciles
four surfaces that each hold a different subset of the keys, and the registry lift in
`20fb9057` fixed a real defect.

What is not clean is the registry's **lifetime**, and the bookkeeping around the series.
One HIGH defect, found independently by two lanes that did not share context, and confirmed
by the orchestrator reading the wiring directly.

## HIGH — the shell registry is keyed on `activeSessionId`, but up to three sessions render at once

**Where:** `app/renderer/src/App.tsx:588` (`useSessionAgentFaceRegistry(activeSessionId)`)
and `:3601` (the single `AgentFaceRegistryContext.Provider` wrapping the whole shell).

**Verified by the orchestrator, not just reported:**

- `app/renderer/src/workspaceLayout.ts:4` — `MAX_WORKSPACE_PANELS = 3`.
- `app/renderer/src/App.tsx:2941` — `workspacePanels` maps over `workspaceLayout.panels`,
  and each panel carries its **own** `panel.sessionId`.
- `app/renderer/src/WorkspacePanels.tsx:140,218` — every panel's `content` renders
  simultaneously, each a `SessionPane` for a different session.
- All of them sit inside the one provider at `App.tsx:3601`, whose value is minted from
  `activeSessionId` alone.

**Two consequences.**

1. *Cross-session pollution.* Up to three sessions' workers share one dedupe pool. The ten
   fills in `AGENT_FACE_IDENTITY_FILL` are spent across all panels, not per session, and one
   session's silhouettes depend on what an unrelated session drew first. This is precisely
   the outcome `agentFace.ts:783-786` gives as its reason for rejecting a module-level
   registry: dedupe is a property of one session's set of workers. Split view turns the
   shell registry into the module-level one that comment rejects.
2. *Settled rows can change face.* Focusing a different panel calls `setActiveSessionId`
   (`WorkspacePanels.tsx:165` → `focusWorkspacePanelSession`) without unmounting the others.
   The provider value flips, every consumer re-registers into a fresh empty registry, and
   already-drawn rows in a still-mounted pane are re-derived in whatever draw order the
   current scroll window and expansion state produce. That violates the governing rule that
   a transcript row is never rewritten after the fact, with no unmount, no restore and no
   reload. Before `20fb9057` the registry was a ref inside `TranscriptRowsView` and survived
   this case.

**Prescription (not implemented — see Parked).** Keep the shell provider for shell-level
surfaces, which legitimately follow the active session: the docked roster, the Workers list,
a relayed permission card. Give each **panel** its own session's registry and provide it to
that panel's subtree. That needs a per-session registry store at the shell rather than a
single ref, with eviction when a session closes. This changes where the provider mounts in
a large, high-traffic file, and it is a design call on a just-landed feature, so it is the
owning session's or the operator's to make.

**Not covered by any test**, and `agentFace.dom.test.ts:59-67` currently pins "a different
session gets a different registry" as correct, which is right for a single-pane shell and is
exactly what breaks the split-pane one.

## MEDIUM — the async terminal stamp is the one gate that ignores the worker's own provider

**Where:** `src/tools/AgentTool/agentToolUtils.ts:1032`.

```ts
const terminalAccount =
  resolveRequestProvider(metadata.resolvedAgentModel) === 'openai'
    ? snapshotLeaseAccount(taskId)
    : undefined
```

Every other gate in the feature passes `toolUseContext.options.mainLoopProvider` as
`baseProvider` (`AgentTool.tsx:266`, `:319`, and all five stamp sites). This one omits it, so
`resolveRequestProvider` falls back to `getAPIProvider()`, the process-global session
provider. `toolUseContext` is destructured in the same function at `agentToolUtils.ts:921`,
so the correct value is in scope and simply unused.

Reachable without any provider switch: a `gpt-*` worker spawns a background child on a Claude
model; the child's `mainLoopProvider` is `'openai'` so it genuinely leases and spends a Codex
account, but at its terminal the global provider says `firstParty`, the gate drops the
account, and the stored result carries no stamp. Also fires when the session switches back to
Anthropic while a background Codex worker is still running.

Fail-safe in direction: it silently drops true stamps, it cannot invent false ones.

**The one-line fix**, for whoever owns this file next:

```diff
-      resolveRequestProvider(metadata.resolvedAgentModel) === 'openai'
+      resolveRequestProvider(
+        metadata.resolvedAgentModel,
+        toolUseContext.options.mainLoopProvider,
+      ) === 'openai'
```

`toolUseContext` is already a destructured parameter of `runAsyncAgentLifecycle`
(`agentToolUtils.ts:921`), so nothing else has to move.

**Not fixed here**, deliberately. Those three files were dirty with another session's live
edits during the review, and that session then landed `2763a080` while this report was being
written. That commit is **comment-only on this exact block** and does not fix it; worse, its
new wording now asserts the false premise outright ("Gated on the worker's own model, like
every other capture. Registration is gated the same way now"), when registration passes
`baseProvider` and this call does not. A session is demonstrably live in this file, and §9's
engine bar wants a test that fails before and passes after, which here means driving a whole
async lifecycle. Both reasons point the same way: hand it over rather than half-land it.

## MEDIUM — three deviations from the design spec, one recorded

The prototype has no worker face at all; it is a cat-code invention, so the spec of record is
`docs/design-html/2026-08-21-agent-face-beyond-the-transcript.html`.

| Where | Spec | Shipped | Recorded? |
|---|---|---|---|
| `OrchestratorRoster.tsx:154-155` | the face **replaces** the pip on the promoted lead | face **and** pip, adjacent | no |
| `TasksDialog.tsx:508-509` | same replacement | face and pip | code comment only (`:483-487`) |
| `PermissionPrompt.tsx:392-410` | 13px stamp leads the **kicker** row | stamp sits inside the 11px subtitle sentence | no |

Consequence of the first two: the same worker presents the same two marks in two different
arrangements in the docked roster (face … pip) and the Workers list (face → pip).

That spec page is also still **untracked**, so a later reader cannot check parity against the
thing this feature was built from.

## MEDIUM — the identity palette reuses the state and type hues

`agentChromeModel.ts:35-46` draws identity from `amber-300`, `rose-300`, `emerald-300`,
`lime-300`, `blue-300`, `sky-300`, `teal-300`, `violet-300`. Those are the hue families that
carry meaning in the same rows: warn, danger, good, running, and the four type tones. A
completed worker can wear an amber stamp beside a green pip. The palette comment reasons only
about excluding the accent pink.

This is a coherence gap opened by the 2026-08-21 identity-colour ruling, which post-dates the
design page (where face and pip agreed because both were the state colour). It is not a
deviation from the ruling.

## LOW — colour identity is gone past ten workers

`FACE_FILL_COUNT = 10`. Measured on the real registry: at 40 workers the fill histogram is
`[3,2,2,4,4,7,7,4,4,3]`, one colour used seven times. Past ten, `resolveFill` stops deduping
and returns the raw hash. Shape identity holds (40/40 distinct, and 400/400 at 400 workers),
so identity survives, but `agentFace.ts:12` declares the whole stamp to be identity, shape
and colour both, and the colour half is not true on any real fan-out. Nothing states what
happens above the ceiling and no surface degrades at it.

## LOW — a name-only surface can hand the first worker's face to a second under one handle

`agentFace.ts:719-723`. `faceFor('a1','Ada')` and `faceFor('a2','Ada')` correctly mint two
faces, but a later `faceFor(null,'Ada')` — what `TaskNotificationBox` and `OrphanedAgentCard`
do — skips the ownership check because `key` is falsy and adopts the first worker's face.
Arguably inherent, since the summary string genuinely carries only a name, but
`agentFace.ts:13` states the invariant unconditionally and there is no contested-alias
fallback.

## Gates that PASS

- **Desktop security baseline.** The series touches no `app/shared`, `app/preload`,
  `app/main`, `app/host` or `app/sidecar` file, so no new inbound frame, preload channel or
  IPC message exists and no protocol version was owed. T6/T6b are untouched: the whole
  `PermissionPrompt.tsx` diff is display-only, and the range contains zero hits for
  `updatedInput`, `updatedPermissions`, `alwaysAllow` or `suggestion`. The Codex account that
  reaches the renderer is `{accountId, accountAlias}`, alias-validated to 1-32 word
  characters, runtime-narrowed at `transcriptProjector.ts:2112-2123` and displayed as
  `alias ?? accountId.slice(0,8)`. No token fragment crosses.
- **Fast Refresh boundary.** Export sets are byte-identical at both ends of the range in all
  six production `.tsx` modules; the new non-component code went into `agentFace.ts`.
- **`as` casts.** Zero added; one hand-rolled ref cast removed.
- **Display degrades.** `useAgentFaceRegistry` falls back to `UNSCOPED_REGISTRY`,
  `faceFor(null,null)` returns the featureless stamp, and the fill index wraps. Nothing throws.
- **§7 user-visible text.** Clean, both halves. The range adds no new on-screen prose and
  moves three strings toward the rule. A repo-wide em-dash sweep filtered 1,407 renderer hits
  down to 64 candidates, all resolved as comments or the one standing fixture exclusion.
- **Orphans.** The series created none. The three zero-consumer exports in `AgentChrome.tsx`
  (`AgentRoleDot`, `AgentStateWord`, `OrchestratorBadge`) are all pre-existing and all carry
  parity-ledger rows, so deleting them is the operator's call, not a sweep item.

## Corrections to the lanes' own claims

- One lane reported that no `App.test.tsx` exists and nothing renders `<App/>`. Both are
  wrong: `app/renderer/src/App.test.tsx` is 2,857 lines and renders `<App />` at `:164`. The
  underlying point survives — nothing pins the provider — but the file it should live in
  exists.
- The Codex account **stamping** commit `9cffc927` is the exclusive base of the range, so it
  is not inside it. What the range contains is `e8bf9924`, which narrows the exposure.
- A first-pass measurement of the §7 sweep's blind spot reported 6,340 hidden literals. That
  was a regex artefact from backticks pairing across doc comments. The AST-based count is
  **107** (see below).

## A mechanism gap this review exposed

`app/renderer/src/userVisibleText.test.ts` extracts quoted literals **line-scoped**, on
purpose: an apostrophe in prose otherwise opens a bogus literal that runs to the next quote
anywhere in the file. The consequence is that a **multi-line template literal is invisible to
the sweep entirely**, because no single line of it carries a matched pair of backticks.

Proven against real history rather than asserted: `DESKTOP_SYSTEM_PROMPT_ADDENDUM` contained
the text `[Bar.tsx:42](app/components/Bar.tsx:42)` both before and after commit `c3745ab0`.
As a five-line literal the extractor never saw it; collapsed to one line by that commit it
became a candidate and failed the gate. The text did not change, only its shape.

Measured with the TypeScript parser over the four swept roots: **107** multi-line prose
template literals are structurally invisible, and **zero** of them currently trip a banned
term or pattern. So the gap is real but is not hiding a live violation, and closing it is
worth doing on its own schedule rather than urgently.

The gate failure itself is fixed in `ea37ee8f` with the `§7-ok` marker the rule prescribes,
because that string is appended to the model's system prompt and is never rendered. The
exemption is on the audience, not on the words.

## Bookkeeping owed

`docs/migration/STATUS.md` carries **no row** for this series. The nearest row, CC-58, is now
partly contradicted by it: CC-58 says the permission card names `@handle` plus role (the
at-sign was removed by `d6490001`) and that the flat worker roster is deliberately unchanged
(its leading slot is now the face). §9's desktop bar asks for a STATUS row with parity
deviations flagged; neither exists.

`docs/migration/PARITY-LEDGER.md` has three citations made stale by this series (`:583` the
relay subtitle, `:1464` the roster row's trailing lifecycle, `:1447` an `AgentChrome.tsx`
line number invalidated by the same commit that wrote it). It was **dirty with another
session's edits** throughout this review and was deliberately not touched.

## What landed from this review

| Commit | What |
|---|---|
| `ea37ee8f` | the red `userVisibleText` gate, fixed with the documented `§7-ok` exemption |
| `5a1349c6` | five comments that still described the face's colour as a state signal |
| (tests) | `TasksDialog` and `PermissionPrompt` registry-identity tests, replacing two assertions that could not fail |

Both new tests assert the no-provider render draws the *other* colour, so each proves it can
distinguish both outcomes rather than merely passing.
