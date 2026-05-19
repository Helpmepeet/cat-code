# GPT-Native Edit Tool (`FilePatchTool`) — Implementation Plan

Plan for replacing Cat Code's Claude-shaped `FileEditTool` with a GPT-native
`apply_patch` tool on the OpenAI provider path. Claude keeps `FileEditTool`
unchanged.

Date: 2026-04-17
Revised: 2026-04-17 (native-tool probe, combined phases, applier semantics)
Related investigation: `docs/reports/2026-04-30-session-dfa2ff01-edit-error-investigation.md`

Phase 0 result: ChatGPT Codex backend rejects native `tools=[{type: "apply_patch"}]`
with `400 Unsupported tool type: apply_patch`. It does accept a freeform
`{type: "custom", name: "apply_patch"}` tool and streams calls as
`custom_tool_call` items with `response.custom_tool_call_input.delta/done`
events. Phase 1 therefore implements the custom/freeform path.

---

## Motivation

Session `dfa2ff01` produced 6 `Edit` failures under GPT-5.4: 4 no-ops and 2
ambiguous-match. Raw payload analysis showed:

- All 4 no-ops were byte-identical `old_string`/`new_string` pairs at the model
  output layer. Not a normalization artifact.
- All occurred at **139k–183k input tokens** with tiny output tokens (73–212).
- Each was a small, mechanical parallel edit (add one union member, add one
  param, swap a template var, remove a duplicate import).
- Model believed it had succeeded — follow-up text said "plumbing is in" when
  the edit was empty.

The failure shape: under long-context load, GPT regenerates `new_string` as
a copy of `old_string` because the "apply the diff" cognitive step silently
drops. A two-slot find-and-replace schema has no structural way to force the
diff marker to appear.

Claude does not show this pattern because Cat Code's `FileEditTool` shape was
co-designed with Claude's training data. GPT was trained on OpenAI's V4A
unified-diff `apply_patch` format via the Codex harness.

OpenAI's own docs report moving `apply_patch` from JSON function-call to
freeform custom-tool output cut failure rate by **35%** — JSON-escaping the
patch body is itself a failure source.

**Goal:** provider-native tool ergonomics. GPT gets `apply_patch`; Claude keeps
`Edit`. Each model uses the tool shape it was trained on.

---

## Scope

### In scope

- New `FilePatchTool` registered only on the OpenAI provider path
- V4A diff parser + applier
- Freeform (`{type: "custom"}`) invocation channel wired through the Codex
  fetch adapter
- Shared validator module extracted from `FileEditTool` (secrets, permissions,
  read-before-edit, file size, LSP diagnostics)
- Provider-gated registration in `src/tools.ts`
- Updated prompt-parity test to assert intentional divergence

### Out of scope (this pass)

- Any change to `FileEditTool`'s behavior on the Claude path
- Retrofitting `apply_patch` onto Claude
- `FileWriteTool`, `NotebookEditTool` changes
- A generic "diff tool" abstraction — two tools, one shared validator module
- Other provider-native tool work (`update_plan`, split Glob/Grep, typed `git`)
  — tracked for future phases

---

## Design decisions

1. **No feature flag.** Tool registration is unconditional on the GPT path —
   symmetric with how `FileEditTool` is unconditional on the Claude path.
   Personal project, simple switch. Revert path is `git revert` (change is
   additive).
2. **Only `FilePatchTool` for GPT.** No fallback to `FileEditTool`. Giving the
   model a choice between tool shapes is itself the failure mode we're removing.
3. **Native tool preferred, freeform as fallback.** OpenAI exposes
   `apply_patch` as a first-party tool (`tools=[{"type": "apply_patch"}]`) on
   the public Responses API. Our adapter hits
   `https://chatgpt.com/backend-api/codex/responses` (the ChatGPT Codex
   backend, not `api.openai.com`), so native-tool support there is not
   publicly documented. Start Phase 1 with a small probe: if the backend
   accepts `{type: "apply_patch"}` and returns `apply_patch_call` items, use
   the native tool. Otherwise fall back to `{type: "custom"}` freeform with a
   V4A envelope prompt. Either way the model emits a V4A diff — only the
   framing differs.
4. **Parallel tools, shared validators.** `FileEditTool` and `FilePatchTool`
   live side-by-side. Pure validation logic (secret guard, permissions, read
   state, UNC guard, size limit, LSP cleanup, history tracking) moves to
   `src/tools/FileEditTool/shared.ts` and is imported by both.
5. **Single phase covering Update, Add, Delete.** Do not split by op type.
   Every V4A op is `*** <Verb> File: <path>` followed by content — marginal
   cost of supporting all three is small, and rejecting Add/Delete invites
   model retry loops. Multi-file in one patch also shipped in the first pass.
6. **Exact matching only, no fuzzy fallback.** Failures in session `dfa2ff01`
   were full-block copies, not whitespace drift. Claims that compaction makes
   exact anchors fragile are speculative; Codex's own applier is byte-exact.
   Fuzzy matching is rejected because a silent mis-apply is worse than a
   recoverable error. Revisit only if real session data shows anchor drift.

---

## Architecture

### Tool registration

`src/tools.ts:204` currently registers `FileEditTool` unconditionally. Change to:

```ts
...(isGPTPromptStyle() ? [FilePatchTool] : [FileEditTool]),
```

`isGPTPromptStyle()` already exists at `src/constants/promptStyle.ts:14`.

### Adapter changes

`src/services/api/codex-fetch-adapter.ts`:

- `translateTools` (line 160): accept per-tool
  `toolType: 'function' | 'custom' | 'apply_patch'`. Default `'function'`.
  `FilePatchTool` emits `{type: "apply_patch"}` if the probe confirms backend
  support, otherwise `{type: "custom"}` with grammar.
- Streaming handler (lines ~634, ~759): add a branch for the relevant output
  event type:
  - Native path: `apply_patch_call` items arrive with `operation.type`,
    `operation.path`, `operation.diff` already split. Normalize to a tool_use
    where `input.input` holds the per-file diff body (hunks only) plus a
    separate `operation.type` and `operation.path`.
  - Freeform path: extract the raw `*** Begin Patch ... *** End Patch` text
    and route as a single-field tool_use.
- Downstream tool handler is envelope-agnostic: by the time `FilePatchTool`
  receives input, it already has `op`, `path`, and the hunk body — so parser
  code paths converge after the adapter.

### Tool wiring

`FilePatchTool.tsx` uses `buildTool`, same as every other tool. Input shape
depends on which adapter path we took:

- **Native path:** input is `{ ops: [{type, path, diff}, ...] }` — the adapter
  normalizes the stream items into this list before calling the tool.
- **Freeform path:** input is `{ input: string }` — full envelope text; the
  tool parses the `*** Begin Patch ... *** End Patch` envelope into the same
  `ops` shape and then shares code with the native path from there.

Tool handler steps (shared):

1. Parse or receive `ops` list (Update / Add / Delete)
2. For each op, run shared validators (secrets, permissions, read state, size)
3. Apply hunks in memory against a mutable per-file buffer. **Each hunk is
   located by content-matching its `@@` anchor and surrounding context against
   the *current mutated buffer*, not by original line number.** This is how
   later hunks still anchor after earlier hunks change line counts. If a later
   hunk's anchor was removed by an earlier hunk, that's a real conflict —
   return an error, don't guess.
4. Write all files; if any op fails mid-apply, abandon all in-memory state
   and return a single error (no partial writes on disk).

---

## File layout

```
src/tools/FilePatchTool/
  constants.ts          FILE_PATCH_TOOL_NAME = 'apply_patch'
  types.ts              input / output types
  parser.ts             V4A envelope parser
  applier.ts            hunk application + rollback
  prompt.ts             tool description: V4A spec + worked example
  FilePatchTool.tsx     buildTool wrapper
  UI.tsx                render tool-use + diff via existing gitDiff renderer
  parser.test.ts
  applier.test.ts

src/tools/FileEditTool/
  shared.ts             NEW — extracted validators (no behavior change)
  FileEditTool.ts       MODIFIED — imports from shared.ts, no other changes
  ... (unchanged)

src/tools.ts            MODIFIED — provider-gated registration at line 204
src/services/api/codex-fetch-adapter.ts   MODIFIED — freeform tool support
src/utils/providerPromptRegressions.test.ts   MODIFIED — divergence-aware test
```

---

## V4A format spec (what the parser accepts)

Envelope (freeform path only — native path gets ops pre-split by the API):

```
*** Begin Patch
*** Update File: path/to/file
@@ <unique context line>
 context line
-line to remove
+line to add
*** End Patch
```

Line prefixes inside a hunk:

- ` ` (space) — context (unchanged)
- `-` — remove
- `+` — add

Hunk header:

- `@@ <text>` — text must match uniquely in the target file (against the
  current mutated buffer). Ambiguous or not-found → error, same discipline
  as `FileEditTool`.

Supported operations (day 1):

- `*** Update File: <path>` — one or more `@@` hunks
- `*** Add File: <path>` — followed by full file contents as `+`-prefixed lines
- `*** Delete File: <path>` — no body
- Multiple file blocks in one patch are allowed and applied atomically (all
  succeed or none are written)

Not supported initially (can add later if used):

- `*** Move File:` — rename+edit combo, parse but reject with specific error

Edge cases to handle in parser:

- `\ No newline at end of file` marker — tracked, passed through to writer
- Empty context lines inside a hunk (rare but legal) — must still be prefixed
  with a space
- `@@` appearing inside a line's content — hunk header detection only on
  line-start
- CRLF vs LF — preserve the file's existing line ending (same logic as
  `FileEditTool`)

---

## Prompt shape for `FilePatchTool`

**Native path: no prompt needed.** OpenAI's docs say explicitly: *"you don't
provide an input schema; the model knows how to construct operation objects."*
The model was trained on V4A and will emit it natively when the tool is
enabled. Ship the tool description as a short one-liner describing capability,
not format.

**Freeform path:** compact spec + one worked example. Draft:

```
Apply one or more hunks to a single file using V4A unified-diff format.

Envelope:
  *** Begin Patch
  *** Update File: path/to/file
  @@ <unique context line from the file>
   unchanged line (prefix with one space)
  -line to remove (prefix with -)
  +line to add (prefix with +)
  *** End Patch

Rules:
- The line after @@ must be a line that appears uniquely in the target file.
- Include 1–3 unchanged context lines around each change so the hunk is
  self-locating.
- Use multiple @@ hunks for multiple edits in the same file.
- You must Read the file before patching it.

Example:
  *** Begin Patch
  *** Update File: src/agent-mode/orchestrator.ts
  @@ async advance(options?: {
    async advance(options?: {
      implementationLanes?: OrchestratorExecutionLane[]
  +   onCheckpoint?: (c: Checkpoint) => void
    }): Promise<OrchestratorAdvanceResult> {
  *** End Patch
```

This prompt ships only on the GPT path. Claude's `FileEditTool` prompt is
untouched.

---

## Phased delivery

### Phase 0 — probe (blocker, ~2 hours)

Send a throwaway request to `https://chatgpt.com/backend-api/codex/responses`
with `tools=[{"type": "apply_patch"}]` and a one-line user prompt that should
trigger an edit. Check response shape:

- Endpoint accepts the tool type → native path, skip envelope prompt/parser
- Endpoint rejects → freeform path, ship envelope prompt + parser

Outcome recorded in this doc before starting Phase 1.

### Phase 1 — full Update/Add/Delete, multi-file, unconditional

**Estimated effort:** ~2 days

Steps, in order:

1. **Extract `FileEditTool/shared.ts`** — pure refactor, no behavior change.
   Run `FileEditTool` tests after to confirm.
2. **Scaffold `FilePatchTool/`** — applier + types + unit tests. Parser only
   if Phase 0 chose freeform path.
3. **Wire adapter** — `translateTools` learns the chosen `toolType`; stream
   handler normalizes output items to ops.
4. **Build `FilePatchTool.tsx`** — compose shared validators + applier; handle
   `Update`, `Add`, `Delete`; atomic multi-file transaction.
5. **Update `src/tools.ts`** — provider-gated registration at line 204.
6. **Update `providerPromptRegressions.test.ts`** — assert intentional prompt
   divergence (Claude → FileEditTool prompt, GPT → FilePatchTool prompt).
7. **Smoke test** — manually reproduce the failing `orchestrator.ts` edit from
   session `dfa2ff01` under GPT; confirm it lands on first try.

**Exit criteria:**

- [ ] Phase 0 probe result recorded
- [ ] Parser unit tests pass if freeform path (envelope, multi-hunk,
      `\ No newline` marker, CRLF preservation)
- [ ] Applier unit tests pass:
  - content-match hunk location (not line-offset)
  - multi-hunk within a file (anchor still resolves after earlier hunks
    mutate the buffer)
  - real conflict surfaces as error, not guessed fix
  - Update / Add / Delete all supported
  - multi-file transactional write (all-or-nothing)
- [ ] Adapter round-trip test: tool registered → request carries correct tool
      type → streamed output parsed → handler receives normalized ops
- [ ] `FileEditTool` tests still green (no Claude-path regression)
- [ ] Manual smoke test on session `dfa2ff01` reproduction passes

### Phase 2 (future, separate decision)

Extend the provider-native tool pattern to:

- `update_plan` shape for GPT's `TodoWrite`
- Split `Glob` / `Grep` into separate tools on GPT (matches Codex harness)
- Dedicated typed `git` tool

Contingent on Phase 1 showing a real quality uplift in practice.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Parser has bugs; every GPT edit breaks | Medium | Extensive unit tests before flipping registry. `git revert` is clean (additive change). |
| Adapter `strict: true` breaks freeform | Low | Set `strict: false` for `FilePatchTool`; confirm against real Codex response shapes in adapter test. |
| Permission / secret-guard divergence drifts between the two tools | Medium | Shared module (`FileEditTool/shared.ts`) imported by both — single source of truth. Lint rule: no inline duplication of those checks in either tool. |
| `providerPromptRegressions.test.ts` blocks merge | Low | Update the test in the same PR to assert intentional divergence: Claude path → FileEditTool prompt, GPT path → FilePatchTool prompt. |
| Model fragments a patch across two tool calls | Low | Parser returns a clear error; model recovers on next turn. Do not attempt to stitch fragments. |
| Context line chosen by the model matches multiple lines | Medium | Same error path as `FileEditTool`'s ambiguous-match case; error message instructs the model to expand context. |
| V4A format drift in future GPT versions | Low | Parser is small and isolated; a format change is a localized update. Monitor `openai/codex` repo for prompt changes. |
| ChatGPT Codex backend rejects native `{type: "apply_patch"}` | Medium | Phase 0 probe catches this before any build work. Freeform fallback is already planned. |
| Mid-session provider switch: prior Claude-shaped `Edit` tool_use items in history confuse GPT when only `FilePatchTool` is registered | Medium | **Tracked as follow-up, not a Phase 1 blocker.** Not unique to this tool — affects every provider-divergent tool. Fix belongs in a generic history-sanitization pass at the provider-switch boundary, masking or renaming historical tool calls whose tool is no longer registered. |
| Later hunks fail because their `@@` anchor was removed by earlier hunks | Low | Applier content-matches against the mutated buffer on every hunk. When an anchor is genuinely gone, error out — do not guess. This is a real conflict and the model should see it. |

---

## Success metric

Re-run the tasks that caused session `dfa2ff01`'s failures under the new tool
and measure:

- **Zero no-op errors** — should be structurally impossible (no `new_string`
  slot to copy into)
- **Fewer ambiguous-match errors** — V4A's `@@` + context lines provide
  stronger disambiguation than a single `old_string` blob
- **Shorter recovery loops** when errors do happen — one re-read, not three

Secondary: no regression in Claude edit success rate. Measured by comparing
pre- and post-change sessions on the same task set.

---

## Open questions resolved

1. ~~Feature flag for Phase 1?~~ **No flag.** Personal project, clean revert.
2. ~~Keep `FileEditTool` as fallback for GPT?~~ **No.** Single tool per
   provider — giving the model a choice is the failure mode.
3. ~~Freeform now or defer?~~ **Prefer native `{type: "apply_patch"}`, fall
   back to freeform if the ChatGPT backend rejects it.** Phase 0 probe
   decides. Either way the model emits V4A; only the framing differs.
4. ~~Phase split (Update only → Add/Delete later)?~~ **Single phase, all
   ops.** Splitting invites model retry loops on unsupported ops and the cost
   saving was minimal.
5. ~~Fuzzy anchor matching for compaction drift?~~ **No.** Observed failures
   were full-block copies, not whitespace drift. Exact match only; revisit on
   evidence, not speculation.
6. ~~Mid-session provider-switch history sanitization?~~ **Out of scope for
   this plan.** Tracked as a generic follow-up — affects every
   provider-divergent tool, not just Edit.

---

## References

- Investigation: `docs/reports/2026-04-30-session-dfa2ff01-edit-error-investigation.md`
- Related GPT-style prompt work: `docs/prompts/2026-04-30-gpt-execution-discipline-patch.md`
- Provider style helper: `src/constants/promptStyle.ts`
- Codex adapter: `src/services/api/codex-fetch-adapter.ts`
- OpenAI `apply_patch` guide:
  https://developers.openai.com/api/docs/guides/tools-apply-patch
- Codex prompting guide (GPT-5):
  https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide
- Codex prompt source (gpt-5.2-codex):
  https://github.com/openai/codex/blob/main/codex-rs/core/gpt-5.2-codex_prompt.md
