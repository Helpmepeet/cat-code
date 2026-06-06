# GPT `apply_patch` UX Improvements — Implementation Plan

Reduce friction between GPT-5.4 and our `FilePatchTool` so the model reaches
the right patch on the first try more often, and recovers faster when it
doesn't.

Date: 2026-04-17
Revised: 2026-04-17 (absorb review: uniqueness check, eval suite,
telemetry-now, atomicity note, sentinel distinctiveness)
Scope: GPT provider path only. Claude path (`FileEditTool`) unchanged.
Related: `docs/plans/2026-04-30-apply-patch-tool-plan.md` (original tool plan)

---

## Status: behavior shipped — verified 2026-05-22

The original failure ("2–4 attempts for a simple edit") **no longer
reproduces.** `FilePatchTool` is live on the GPT path (`src/tools.ts:213`,
`getProviderFileEditTool` returns it when provider is OpenAI). All five root
causes are addressed and covered by the test suite (30 passing).

**Implementation diverged from this plan — for the better.** Rather than the
`>>>BOF<<<` sentinel + strict-only matching this doc proposed, the code
adopted **canonical Codex V4A semantics**:

- **BOF (root cause 1):** a pure-insert first hunk prepends; no sentinel.
  `applier.ts:230`. The `BOF_SENTINEL` constant was never added.
- **EOF:** `*** End of File` marker with tail-first-then-full-scan search.
  `applier.ts:227,249`. (Plan left this as "test, add if needed" — it's in.)
- **Anchor-out-of-order (root cause 2):** fixed.
- **Read-gate (root cause 3):** no hard gate; instead a changed-on-disk
  detector compares against the cached read and says so explicitly.
  `applier.ts:277`, threaded via `cachedFiles` in `FilePatchTool.tsx:280`.
- **Remediation hints (root cause 4):** every throw site carries a "how to
  fix" suffix. `applier.ts:235,265,287,295`.
- **Full-hunk-fingerprint uniqueness (root cause 5):** `findHunkPosition`
  scans the whole file and throws `PATCH_ANCHOR_AMBIGUOUS` listing collision
  line numbers. `applier.ts:259-267`.
- **Beyond plan:** 4-tier fuzzy matching (exact → trimEnd → trim →
  unicode-normalize) and `@@` scope-hint disambiguation
  (`disambiguateWithScopeHints`). The plan had explicitly deferred fuzzy
  matching pending Phase 0 telemetry; it shipped anyway.

**Outstanding (measurement scaffolding only — not behavior):**

1. **Phase 0 telemetry never landed.** `fileOperationAnalytics.ts` has no
   `file_patch_failure` event or drift tags. Ironically this was meant to
   justify the fuzzy-matching decision that shipped without it.
2. **Eval suite is half-built.** All 12 fixtures exist under `__fixtures__/`
   but no `applier.eval.test.ts` driver references them — they're dead files.

Neither blocks the fix. Pick them up only if future tuning needs the data.
The phased plan below is the original proposal, retained for history.

---

## Motivation

Testing the new `FilePatchTool` against a simple "add a comment at the top of
a file" task showed the model needed 2-4 attempts. Root causes, in order of
observed impact:

1. **BOF insert was unsupported.** Parser required the anchor to be repeated
   as the first context line of the hunk. "Insert before line 1" has no
   preceding context, so the model retried until it stumbled into
   "replace line 1 instead."
2. **Parser rejected anchor-out-of-order hunks.** Even when the model emitted
   a valid V4A hunk with `+` lines before the anchor context, the parser
   threw `INVALID_PATCH_FORMAT`. (Fixed in-flight.)
3. **Forced Read-before-Edit.** Claude-style gate that runs a redundant Read
   round-trip on every edit, even when the file is already in the model's
   context. Fights GPT-5.4's training — Codex's native harness doesn't gate
   this way.
4. **Error messages describe the failure, not the remedy.** The model gets
   `"Patch anchor not found"` but no hint that the fix is "re-read the file,
   the anchor may be stale." Longer retry loops than necessary.
5. **Uniqueness is anchor-only.** Review surfaced that the applier's
   `findUniqueAnchorIndex` enforces uniqueness of the `@@` anchor *string*
   only. `findMatchingHunkStart` then tries small alignment offsets around
   that single location and returns the first fit — it never checks whether
   the *full hunk fingerprint* (anchor + context + delete lines) occurs
   elsewhere in the file. Without this, adding "≥2 context lines" as a
   safety compensation is security theater: decorative context doesn't
   actually narrow location.

This plan fixes (1), (3), (4), and (5). (2) is already fixed.

Out of scope: relaxing strict byte-match on context lines. Tracked
separately — requires drift-type telemetry (Phase 0 of this plan) to land
first, then a data-driven decision.

---

## Design decisions

1. **No feature flag.** All changes are additive on the GPT path. `git revert`
   is clean. Claude path is untouched.
2. **BOF sentinel over prompt workaround.** "Use `@@ >>>BOF<<<` as anchor"
   lets the model express a prepend naturally. A prompt rule like "replace
   line 1 instead" forces the model to think about the tool's limitations.
   Sentinel uses `>>>BOF<<<` (not bare `BOF`) for distinctiveness — reduces
   collision with real file content that legitimately contains `BOF` (dict
   keys, generated files, test fixtures). Matching is exact-string; if a
   file line happens to equal `>>>BOF<<<` the patch still fails cleanly
   because the applier picks index 0, not that line's position.
3. **Conditional Read-gate, not removed.** If the file *was* read earlier in
   the session, run `assertFileUnchangedSinceRead` as normal — this is the
   load-bearing safety check and it's only meaningful when a stamp exists. If
   the file was never read, skip the disk-check and rely on
   full-hunk-fingerprint uniqueness + visible failure as the safety net.
4. **Full-hunk-fingerprint uniqueness when no Read stamp exists.** Replace
   the anchor-only check with a scan that verifies the full sequence of
   context + delete lines (normalized to their `text` fields) occurs at
   exactly one location in the file. Rejects hunks whose fingerprint is
   ambiguous with a clear error pointing at the collision. This is the
   actual compensation for removing the Read gate — not "≥2 context lines,"
   which was theater.
5. **Error messages add remediation hints.** Cheap win. Each `FilePatchError`
   gains a short "how to fix" suffix tuned to the failure code.
6. **No speculative fuzzy matching.** Strict byte-match stays. Revisit only
   after Phase 0 telemetry shows which drift mode dominates.

---

## Phased delivery

### Phase 0 — Telemetry tagging (prerequisite, ~0.5 day)

Before changing behavior, tag patch failures by drift type so the
"collect-then-decide" plan for strict matching is actually executable.

**Files touched:**
- `src/tools/FilePatchTool/applier.ts` — classify on throw
- `src/utils/fileOperationAnalytics.ts` (or existing analytics hook) — add
  a `file_patch_failure` event

**Tags:**
- `anchor_not_found`
- `anchor_ambiguous`
- `context_mismatch_trailing_ws`
- `context_mismatch_leading_ws` (tab/space)
- `context_mismatch_unicode` (smart quotes, NBSP)
- `context_mismatch_crlf`
- `context_mismatch_other` (catchall — structural drift)
- `delete_mismatch_*` (same sub-categories)
- `hunk_fingerprint_ambiguous` (new — Phase 2)
- `parse_error_*` (by code: `INVALID_PATCH_FORMAT`, etc.)

Detection is cheap: compare `expected` and `actual` after normalization. If
`expected.trim() === actual.trim()` → trailing ws. If
`expected.replace(/\t/g, '  ') === actual.replace(/\t/g, '  ')` → tab/space.
Etc. Unknown → `other`.

**Exit criteria:**
- [ ] Every `FilePatchError` throw site emits a telemetry event with a drift
      tag
- [ ] Event includes path, op type, failure code, drift tag — no file
      contents (PII)
- [ ] Dashboard or log query confirms events are landing

Phase 0 blocks Phase 3's success metric and the deferred fuzzy-matching
decision. Do it first.

### Phase 1 — BOF sentinel (shipped in-flight; needs revision)

**Currently shipped:**
- [x] Parser accepts anchors without requiring first-context-line repetition
- [x] `BOF_SENTINEL` added to `constants.ts` (currently `'BOF'` — change to
      `'>>>BOF<<<'`)
- [x] `findUniqueAnchorIndex` returns 0 when anchor is the sentinel
- [x] Prompt rule added

**Revisions:**
- [ ] Change `BOF_SENTINEL` from `'BOF'` to `'>>>BOF<<<'` (distinctiveness)
- [ ] Update prompt rule to match
- [ ] Empty-file case: if file is empty and op is Update with `@@ >>>BOF<<<`,
      treat `+` lines as file contents (equivalent to Add File with those
      lines). Explicitly handle and test — don't let it fall through to a
      confusing error.
- [ ] Add parser/applier tests for:
  - BOF prepend on non-empty file
  - BOF on empty file
  - File that contains a literal `>>>BOF<<<` line as content (should still
    work — sentinel resolves to index 0, not to that line)

**EOF sentinel** — not shipped yet. Worth a quick test: does the model fail
on append-to-file-ending-in-`}`? If yes, add `>>>EOF<<<` as a symmetric
sentinel in the same pass. If no, defer. **Decision: test first, within
Phase 1.**

### Phase 2 — Conditional Read-gate + real uniqueness check

**Files touched:**
- `src/tools/FilePatchTool/FilePatchTool.tsx` (`validateInput`)
- `src/tools/FilePatchTool/applier.ts` (`findMatchingHunkStart`)

**Changes:**

1. **Remove unconditional `validateFileWasRead`** for update operations on
   the GPT path.
2. **Make `validateFileNotModifiedSinceRead` conditional on stamp presence.**
   Verify current behavior: does the helper short-circuit when no stamp
   exists? If not, wrap in presence check.
3. **Replace anchor-only uniqueness with full-hunk-fingerprint uniqueness.**
   In `findMatchingHunkStart`, after locating candidate positions, verify
   the hunk body matches at **exactly one** location across the entire file
   (not just the anchor neighborhood). If multiple fingerprint-equal
   locations exist, throw `HUNK_FINGERPRINT_AMBIGUOUS` with a message
   listing the line numbers of the collisions.
4. **Drop the ≥2-context-lines validator.** It was compensating for a
   uniqueness gap that we're now fixing properly. Keep validation lean.

**New uniqueness algorithm (sketch):**

```ts
// Extract the fingerprint: sequence of (kind, text) for non-add lines
const fingerprint = hunk.lines
  .filter(l => l.kind !== 'add')
  .map(l => l.text)

// Scan file for all positions where fingerprint matches
const matches: number[] = []
for (let i = 0; i <= fileLines.length - fingerprint.length; i++) {
  if (fingerprint.every((text, j) => fileLines[i + j] === text)) {
    matches.push(i)
  }
}

if (matches.length === 0) throw PATCH_ANCHOR_NOT_FOUND
if (matches.length > 1) throw HUNK_FINGERPRINT_AMBIGUOUS // list matches
return matches[0]
```

Note: this subsumes `findUniqueAnchorIndex` for the no-BOF case. Keep the
BOF short-circuit (`if anchor === BOF_SENTINEL return 0`).

**Exit criteria:**
- [ ] Model can patch a file it has not Read in this session
- [ ] Model patching a previously-Read file still gets the disk-unchanged check
- [ ] A hunk whose body (context + deletes) occurs twice in the file is
      rejected with a clear error citing both locations
- [ ] Eval suite (Phase 3) confirms no regression on previously-working cases

### Phase 3 — Remediation hints in error messages

**Files touched:**
- `src/tools/FilePatchTool/applier.ts`
- `src/tools/FilePatchTool/parser.ts`

**Changes:** append a short "how to fix" clause to each `FilePatchError`
message. Keep the existing message prefix so existing tests still pass with
a loose match.

| Error code | Current message (fragment) | Added remediation |
|---|---|---|
| `PATCH_ANCHOR_NOT_FOUND` | `Patch anchor not found in ${path}: ${anchor}` | `— re-read the file; the anchor may be stale or the file may have changed. For a prepend, use "@@ >>>BOF<<<".` |
| `HUNK_FINGERPRINT_AMBIGUOUS` (new) | `Hunk body matches ${n} locations in ${path}: lines [${lineNumbers}]` | `— expand the hunk with more surrounding context until only one location matches.` |
| `PATCH_CONFLICT` (context mismatch) | `Context mismatch ... Expected X, found Y` | `— re-read the file to get the current content, then rebuild the hunk from the exact bytes.` |
| `PATCH_CONFLICT` (delete mismatch) | `Delete mismatch ... Expected X, found Y` | `— the line you tried to remove doesn't match what's in the file; re-read and try again.` |
| `PATCH_TARGET_MISSING` | `Cannot ${op} ${path} because it does not exist` | `— check the path, or use "*** Add File:" for a new file.` |
| `PATCH_TARGET_EXISTS` | `Cannot add ${path} because it already exists` | `— use "*** Update File:" to modify the existing file, or choose a different path.` |
| `INVALID_PATCH_FORMAT` (various) | varies | `— see the tool description for the envelope format; common mistakes: missing "*** End Patch", hunk line not prefixed with space/+/-.` |
| `INVALID_PATCH_ENVELOPE` | `Patch must start/end with ...` | `— wrap the patch in "*** Begin Patch" ... "*** End Patch".` |
| `DUPLICATE_PATCH_PATH` | `Patch contains multiple operations for ${path}` | `— combine them into a single Update File block with multiple @@ hunks.` |

**Exit criteria:**
- [ ] All error sites updated
- [ ] Existing parser/applier tests still pass (loose message match)

---

## Eval suite (replaces n=1 success metric)

Before declaring any phase done, run a fixed set of 12 scenarios against
`cli-dev` with GPT-5.4. Each scenario has a fixture file and a task prompt.
Measure: first-try success (patch applies cleanly), total attempts, tokens
used.

1. **Prepend single comment** — add line at top of a code file
2. **Prepend to empty file** — edge case for BOF on empty buffer
3. **Append single line** — add line at end of file ending in `}`
4. **Append to file with trailing newline** vs **without trailing newline**
5. **Mid-file insert** — add a param to a function signature
6. **Single-character delete** — remove a trailing comma
7. **Multi-hunk same file** — add one union member, add one function call
8. **Add File (new)** — create a small file
9. **Delete File** — remove an existing file
10. **Multi-file patch** — one Update + one Add in a single envelope
11. **Hunk with generic context** — patch near a `}` or a blank line
      (tests fingerprint uniqueness)
12. **Patch without prior Read** — file is in conversation history but never
      read via tool (tests Phase 2 relaxation)

Pass criteria per phase:
- Phase 1: scenarios 1, 2 first-try success
- Phase 2: scenario 12 succeeds (previously blocked); scenario 11 succeeds
  or fails with `HUNK_FINGERPRINT_AMBIGUOUS`, not silent wrong-location
- Phase 3: retry count on any failure ≤ 1

Store fixtures under `src/tools/FilePatchTool/__fixtures__/` and driver in
`applier.eval.test.ts` (or similar). Can run as part of regular test suite
since it's deterministic once applier is deterministic; model-in-the-loop
portion runs manually.

---

## Atomicity

Confirmed by reading `FilePatchTool.tsx`:

- **Per-file, multi-hunk:** all hunks applied in-memory via
  `applyPatchToBuffers` before any disk write. If hunk 3 of 5 throws, no
  disk state changes.
- **Per-patch, multi-file:** each file is written inside a `try` that calls
  `rollbackAppliedFiles` on any error. Rollback restores each already-written
  file to its `before` content (or deletes a newly-created file).
- **Crash mid-rollback:** not handled (no crash-safety wrapper around
  rollback itself). Acceptable — same guarantee as `FileEditTool`.

So: **"visible failure is recoverable" holds at the file level.** Add this
note to the risk register — not a blocker, but explicit.

---

## Token economics caveat

The remediation hint "re-read the file" converts first-try failures into
Read-after-failure. That's functionally "lazy Read-gate" and costs more
per-edit than Read-before-edit when the model guesses wrong.

Net token savings depend on GPT-5.4's first-try success rate:

- **If ≥70% first-try:** no-gate wins (save 1 Read per success, pay 2x on
  failures)
- **If <50% first-try:** forced-gate wins
- **50–70%:** close to break-even

Phase 0 telemetry + Phase 3 eval suite tell us which regime we're in. If
eval shows <50% first-try on scenarios 1–12, revisit this decision and
consider reinstating the gate.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Full-fingerprint uniqueness check is too slow on large files | Low | O(n·h) where n = file lines, h = hunk size. For a 10k-line file × 10-line hunk = 100k compares. Fine. Add a fast path (anchor-seeded candidate scan) if profiling shows it's hot. |
| Relaxing Read-gate lets model patch a hallucinated file structure | Medium | Full-fingerprint exact-match makes it a visible failure (patch rejected), not a silent bad merge. Telemetry (Phase 0) will surface if this becomes a pattern. |
| BOF sentinel collides with real file content containing `>>>BOF<<<` | Very Low | Distinctive marker chosen to minimize. Collision is benign — applier picks index 0, not the colliding line; if that's wrong, the hunk body won't match and patch fails cleanly. Tested explicitly. |
| Longer error messages confuse the model more than they help | Low | Remediation is one sentence appended to a clear failure. Matches Codex convention. |
| Multi-file patch: rollback itself fails mid-way (crash, disk full) | Low | Same as `FileEditTool`. Not introducing new risk. Out of scope for this plan. |
| First-try success rate lower than expected, making net tokens worse | Medium | Phase 0 telemetry + eval suite detect this. If <50% first-try, reinstate Read-gate on GPT path with a follow-up revert. |
| Empty-file + BOF ambiguity | Low | Explicitly handled and tested in Phase 1 revision. |
| EOF equivalent is needed but skipped | Medium | Phase 1 tests append-to-`}`-ending file; add `>>>EOF<<<` if it fails. |

---

## Error code allocation

Current `errorCode` values used by `validateInput`: 1 (parse/other), 2
(deny), 3 (add-exists), 4 (target-missing), 5 (notebook), 6 (unread),
7 (stale).

**Changes:**
- `6` (unread) — remains, but no longer triggered on GPT path for updates.
  Still returned for cases where Read is genuinely required (e.g., notebook
  or settings-file edits if we reinstate per-kind gating). Kept for
  compatibility.
- `8` (new) — **unused in current code**, allocated here for any new
  validator if we add one. Phase 2 currently doesn't add a new validator
  (the ≥2-context rule is dropped in favor of the uniqueness check). If
  Phase 2 grows a new validator, it takes `8`.

Confirm by grep before PR: `rg 'errorCode: [0-9]' src/tools/FilePatchTool/`.

---

## Open questions

1. ~~Workaround vs sentinel for BOF?~~ **Sentinel (`>>>BOF<<<`).**
2. ~~Remove Read-gate entirely or keep conditional?~~ **Conditional.**
3. ~~Should we add an EOF sentinel?~~ **Test in Phase 1; add if needed.**
4. ~~Auto-retry with fresh Read on `PATCH_ANCHOR_NOT_FOUND`?~~ **Not in
   this pass.** Telemetry needs raw data first.
5. **Should the full-fingerprint uniqueness check be normalized
   (case/whitespace-insensitive)?** No — strict byte-match stays. This is
   explicitly the "speculative fuzzy matching" we said we wouldn't do.
   Reopen after Phase 0 data.

---

## References

- Original plan: `docs/plans/2026-04-30-apply-patch-tool-plan.md`
- Investigation: `docs/reports/2026-04-30-session-dfa2ff01-edit-error-investigation.md`
- Codex prompting guide: https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide
