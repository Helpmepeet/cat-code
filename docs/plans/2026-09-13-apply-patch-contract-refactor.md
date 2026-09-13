# `apply_patch` Contract and Placement Planner Refactor

Date: 2026-09-13
Status: ready for implementation, with release gates
Owner: pt

Related evidence:

- `docs/reports/2026-08-09-patch-hunk-ambiguity-production-analysis.md`
- Engine session `6c27be0a-aeab-487a-a26c-5a261872157a`
- App session `952385a4-6a8a-4b89-a4de-53a32c75e86c`
- Earlier alignment plan: `docs/plans/2026-04-30-apply-patch-codex-alignment-plan.md`

The April alignment plan is historical context, not the specification for this
work. In particular, this plan does not restore greedy first-forward placement
or allow tolerant matching to authorize a mutation without evidence.

## Outcome

Keep the GPT-native free-form patch interface and rename its canonical tool name
from `Apply_patch` to `apply_patch`. Preserve read compatibility for historical
`Apply_patch` calls.

Refactor update placement into a pure planner that evaluates every hunk in one
update against one immutable execution-time source snapshot. Apply an update
only when its complete ordered hunk set has exactly one placement plan. A later
hunk may resolve an earlier local ambiguity. The planner must never choose the
first candidate merely because it is first.

Keep one `apply_patch` call atomic at preflight: if any operation cannot be
planned or validated, publish none of the operations. Independent edits that
may safely land separately belong in separate tool calls.

Preserve the existing parser, in-memory preflight, filesystem publication,
snapshot recheck, rollback, path authorization, and bounded-persistence
boundaries. The refactor is focused inside patch syntax, source-coordinate
planning, pure application, diagnostics, and model-facing results.

## Why this work exists

The inspected 68-call session had 50 successes and 18 safe rejections. Thirteen
rejections were placement ambiguities, and eight of those occurred on non-first
hunks. Only one call was structurally malformed. The dominant problem is
therefore not agents routinely producing invalid envelopes. It is disagreement
between the model's ordered-patch behavior and the harness's per-hunk uniqueness
policy.

The current implementation has four related problems:

1. `applyUpdateHunks` mutates a working buffer while locating later hunks, so
   generated text can become placement evidence.
2. `findHunkPosition` rejects as soon as one hunk has multiple candidates,
   before later explicit hunks can constrain the complete sequence.
3. `@@` text is described as containing scope, but implementation only searches
   for preceding text. It does not establish language-aware containment.
4. The OpenAI custom-tool grammar accepts arbitrary text, while the runtime
   parser enforces a much narrower language after generation.

The current fuzzy ladder also authorizes edits after trimming whitespace or
normalizing punctuation. That can be convenient, but it can change the wrong
region or remove meaningful indentation. Its production value and error rate
have not been measured. This plan therefore makes tolerant matching
diagnostic-only in the target contract, but requires replay of successful calls
before that policy is released.

## Locked product contract

### Canonical and historical names

- New schemas, prompts, generated calls, model results, and UI labels use
  `apply_patch`.
- Historical transcript items named `Apply_patch` remain readable, renderable,
  classifiable, and resumable.
- Historical items retain their recorded name. Do not rewrite transcript JSONL.
- New execution never advertises both names to the model.
- A shared predicate recognizes the canonical and legacy names wherever old
  persisted messages are consumed.
- Restarting the engine is the contract boundary. Already running engines keep
  their loaded schema until restarted.

### Syntax

- The canonical input remains the V4A-style free-form envelope bounded by
  `*** Begin Patch` and `*** End Patch`.
- Generation uses a real Lark grammar aligned with the runtime parser.
- The runtime parser remains authoritative and rejects the complete input before
  mutation when syntax is invalid.
- Recognized historical wrappers may remain accepted by the runtime parser, but
  the generation grammar emits only canonical syntax.
- A malformed suffix is never discarded and a valid prefix is never executed.
- Syntax validation does not attempt to judge whether replacement code is
  semantically correct.

### Placement

- One update operation uses one immutable source snapshot.
- Context and deletion lines form each hunk's old-side fingerprint.
- Candidate runs are represented in original source coordinates.
- Hints, hunk order, non-overlap, BOF, EOF, and newline markers are constraints
  over candidates.
- The planner counts complete ordered plans, capped at `many`; it need not
  enumerate every plan after a second valid plan is found.
- Zero complete plans reject with the most useful violated constraint.
- One complete plan authorizes pure in-memory application.
- More than one complete plan rejects as ambiguous.
- Different source regions remain different plans even when they produce equal
  output bytes.
- Later hunks may disambiguate earlier hunks, including a locally ambiguous
  first hunk.
- Earlier inserted or replaced text is never searched when locating a later
  hunk.

### Matching authority

- Exact old-side matching authorizes mutation.
- Patch LF transport may describe CRLF source files; line-ending transport
  normalization is not fuzzy source matching.
- Whitespace, indentation, Unicode punctuation, and bounded similarity matching
  may locate diagnostic candidates only.
- Diagnostics label approximate candidates as non-authoritative.
- There is no model-selectable force flag or fuzzy-apply mode in this work.
- The release gate must measure successful calls that currently rely on tolerant
  matching. If exact-only matching is not usable, amend this contract with a
  narrowly justified rule rather than silently retaining the current ladder.

### Textual hints

- Bare `@@` is normal and contributes no hint.
- Nonempty `@@` text is a mandatory literal preceding-text constraint.
- It is not a class, function, indentation, or AST containment promise.
- Stacked hints must appear on distinct source lines in their supplied order.
- Hints are evaluated against the immutable source snapshot.
- A hint supplies no implicit lower boundary. When a lower boundary matters,
  the patch must provide later literal context.
- Missing hints never fall back to an unhinted match.

### Boundaries and insertions

- A context-free first hunk without EOF retains BOF insertion semantics.
- A context-free EOF hunk appends.
- Other insertion positions require literal old-side context.
- `*** End of File` is a hard constraint. A fingerprinted EOF hunk must consume
  through source EOF, and an EOF hunk must be last in its update.
- There is no interior fallback for an EOF-marked hunk.
- No-newline markers carry explicit old-side and new-side meaning based on the
  preceding patch line. They are validated at the corresponding EOF.
- Unaffected source bytes, BOM state, encoding, and line-ending style remain
  preserved to the extent already supported by `readFileForEdit` and the
  publication helpers.

### Operations and atomicity

- Add requires an absent target and never overwrites.
- Update applies one unique source-coordinate plan.
- Delete retains the complete model-visible Read and identity requirements.
- Move-with-edit plans against the source snapshot and requires an absent,
  authorized destination.
- Source paths and destinations remain independent. Reject duplicate, aliased,
  overlapping, chained, or swapped targets.
- All operations complete in-memory preflight before filesystem publication.
- Any preflight failure means no operation is published.
- Diagnostics may report that other independent operations produced candidate
  plans, but must not call them applied or guaranteed to succeed later.
- Publication remains guarded by mutation locks and execution-snapshot rechecks.
- Publication failure retains the existing `no-mutation`, `complete-rollback`,
  and `incomplete-recovery` outcomes.
- Multi-file publication is not described as crash-atomic.

## Proposed internal design

### Validated syntax representation

Extend the parser representation without changing the public envelope:

```ts
type PatchSourceSpan = {
  startLine: number
  endLine: number
}

type FilePatchHunk = {
  hints: string[]
  lines: FilePatchLine[]
  isEndOfFile: boolean
  noNewline: {
    oldSide: boolean
    newSide: boolean
  }
  sourceSpan: PatchSourceSpan
}
```

Names may vary during implementation, but the representation must preserve
patch-source locations and distinguish old-side from new-side newline state.
Legacy structured `{ ops }` input without the new fields must normalize to the
same internal representation with safe defaults.

### Placement evidence

Add a pure placement module, preferably
`src/tools/FilePatchTool/planner.ts`, with no filesystem access and no prose
formatting. Its useful concepts are:

```ts
type HunkCandidate = {
  hunkIndex: number
  sourceStart: number
  sourceEnd: number
  hintLines: number[]
  boundary: 'none' | 'bof' | 'eof'
  matchTier: 'exact'
}

type PlannedHunk = HunkCandidate

type UpdatePlacementPlan = {
  path: string
  sourceIdentity?: FileIdentity
  hunks: PlannedHunk[]
}
```

The planner should return structured success or failure evidence rather than
throwing preformatted sentences. The caller may still convert failures into
`FilePatchError` for the existing tool boundary.

### Unique-plan algorithm

For every hunk, enumerate exact candidates in the source snapshot, then filter
them by explicit hint and boundary constraints. Keep candidate arrays in source
order.

Determine complete plans with a bounded dynamic program:

- State is `(hunkIndex, previousSourceEnd)` or an equivalent compact frontier.
- A next candidate is eligible when its consumed source range does not overlap
  the previous candidate and respects file order.
- Count continuations as `0`, `1`, or `many`; stop counting after `2`.
- Retain predecessor information only for a uniquely solvable path.
- If configured resource bounds are reached before uniqueness is known, return a
  stable planner-limit error and make no mutation.

This avoids exponential plan materialization while still allowing later hunks
to resolve earlier local ambiguity.

The algorithm must define zero-width insertions explicitly. Only the documented
BOF and EOF context-free cases create zero-width candidates; ordinary in-file
insertions consume their supplied context. Two hunks must not use overlapping
consumed source ranges.

### Pure application

Replace mutated-buffer searching in `applyUpdateHunks` with two operations:

1. Plan every hunk against the original logical source lines.
2. Apply the chosen source-coordinate edits from the end of the file backward,
   or stream once through the source using the complete ordered plan.

Application must copy unchanged/context source bytes from the source snapshot,
not from the patch text. Added text comes from the patch. It must assert that the
plan is ordered and non-overlapping even though the planner already guarantees
those properties.

### Structured diagnostics

Add `src/tools/FilePatchTool/diagnostics.ts` or an equivalent focused owner.
Diagnostic generation consumes parser and planner evidence. It does not repeat
placement searches through a separate policy.

Failures should preserve:

- stable error code and mutation outcome;
- operation, resolved path, and hunk ordinal;
- patch-source line when syntax is involved;
- original execution-snapshot candidate coordinates;
- distinction among missing fingerprint, nonconsecutive fingerprint, missing
  hint, ordering conflict, hard EOF conflict, ambiguity, permissions, planner
  limit, and snapshot conflict;
- bounded repair guidance.

For a credible near match, report a bounded window around the first divergence,
including line and column. Do not spend the entire error budget repeating a long
common prefix. If several near matches are credible, report the uncertainty. If
no credible candidate exists, do not invent one.

### Success evidence

Extend the optional persisted result shape with a contract version and bounded
placement metadata in original source coordinates. Old outputs remain valid.
Model-facing success should identify affected paths and compact placement ranges
without duplicating whole files. The existing bounded `structuredPatch` remains
the UI and persistence diff representation.

Suggested additive shape:

```ts
type FilePatchPlacement = {
  hunk: number
  oldStart: number
  oldEnd: number
  reason: 'exact' | 'exact+hint' | 'bof' | 'eof'
}

type FilePatchToolOutput = {
  contractVersion?: 2
  files: Array<{
    // existing fields
    placements?: FilePatchPlacement[]
  }>
}
```

Bound the number of reported placements and include an omission count. Do not
persist raw candidate source text solely for telemetry.

## File ownership and changes

### `src/tools/FilePatchTool/constants.ts`

- Set `FILE_PATCH_TOOL_NAME = 'apply_patch'`.
- Add `LEGACY_FILE_PATCH_TOOL_NAME = 'Apply_patch'`.
- Export `isFilePatchToolName(name)` for persisted-history consumers.
- Keep syntax marker constants here or move the grammar-specific set into a
  dedicated syntax module without duplicating string literals.

### `src/tools/FilePatchTool/grammar.ts` (new)

- Own the canonical Lark grammar string.
- Cover operation headers, optional moves, hunk headers, line prefixes, EOF,
  no-newline markers, and required envelope closure.
- Keep legacy wrapper acceptance out of the generation grammar unless the model
  must generate it.
- Export one stable grammar value consumed by API schema construction and tests.

### `src/utils/api.ts`

- Import the canonical tool name and grammar instead of duplicating both.
- Attach the custom-tool format only to the canonical new tool.
- Keep the schema cache keyed by the new name. A process restart naturally
  separates old and new in-memory schemas.

### `src/tools/FilePatchTool/parser.ts`

- Preserve patch-source spans.
- Rename `scopeHints` to an honest internal name such as `hints`, with a legacy
  normalization adapter for structured inputs.
- Validate EOF position and no-newline marker attachment.
- Keep full-envelope fail-closed behavior.
- Keep canonical parsing and historical wrapper normalization visibly separate.

### `src/tools/FilePatchTool/planner.ts` (new)

- Enumerate exact candidates against immutable source lines.
- Evaluate literal hints, ordering, non-overlap, BOF, EOF, and newline
  constraints.
- Count complete plans as zero, one, or many.
- Return structured evidence and bounded planner-limit failures.
- Expose test-only comparison policies needed by replay without exposing a
  runtime force option to the model.

### `src/tools/FilePatchTool/applier.ts`

- Retain operation-level in-memory aggregation and atomic failure behavior.
- Replace `findHunkPosition`, mutated-buffer cursor matching, and mutation-time
  hint searches with planner consumption.
- Apply a completed plan without re-searching.
- Preserve buffer encoding and line-ending metadata.
- Move prose diagnostics to the diagnostic owner.

### `src/tools/FilePatchTool/diagnostics.ts` (new)

- Render structured parser/planner failures into bounded `FilePatchError`
  messages and model metadata.
- Implement divergence-centered long-line diagnostics.
- Keep approximate matching here unless replay infrastructure needs the same
  diagnostic helpers.

### `src/tools/FilePatchTool/types.ts`

- Add parser spans, planner evidence, side-specific newline state, placement
  metadata, and stable error metadata.
- Keep legacy `before`, `after`, and `notes` fields optional for old transcript
  rendering.
- Normalize legacy structured input instead of requiring old stored calls to
  contain new fields.

### `src/tools/FilePatchTool/FilePatchTool.tsx`

- Keep current permission checks, mutation locks, execution snapshot capture,
  settings and secret validation, publication ordering, and rollback machinery.
- Feed immutable `currentFiles` snapshots into the planner/applier.
- If any operation fails planning or validation, publish none.
- Preserve bounded independent-operation failure aggregation.
- Project optional placement metadata into the persisted result and model-facing
  success message.
- Change user-visible tool wording to `apply_patch`.

### `src/tools/FilePatchTool/prompt.ts`

- Generate the name from `FILE_PATCH_TOOL_NAME`.
- Explain whole-update uniqueness rather than per-hunk uniqueness.
- Describe `@@` text as literal preceding text, never containing scope.
- State exact-match mutation authority and diagnostic-only approximate matches.
- State hard EOF and all-or-nothing call behavior.
- Restore concrete examples with sufficient consecutive context, ordered hunks,
  repeated blocks resolved by later context, and an ambiguity that must reject.
- Keep the description concise enough not to erase the benefit of constrained
  generation.

### Historical-name consumers

Audit every exact comparison and use `isFilePatchToolName` only where persisted
history may contain the legacy name. Important owners include:

- `src/services/api/codex-fetch-adapter.ts`
- `src/utils/messages.ts`
- `src/services/autoDream/autoDream.ts`
- `src/services/extractMemories/extractMemories.ts`
- `app/sidecar/readPeerTool.ts`
- `app/renderer/src/transcriptProjector.ts`

New tool selection, prompt assembly, and tool schema emission use only the
canonical constant. Comments, test names, snapshots, and model-facing prose are
updated to lowercase unless they explicitly describe legacy data.

### Codex continuation compatibility

`codex-fetch-adapter.ts` must classify both names as custom patch calls when
recording or replaying historical messages. Preserve the name originally stored
on each old output item and recover its raw patch input exactly as today.

Add a live release check that resumes an old `Apply_patch` session while the
current schema advertises only `apply_patch`. If the backend rejects an old call
name that is absent from the current tool list, do not advertise both tools as a
quick fix. Choose an adapter-level full-send migration that preserves call/result
pairing, accept the intentional continuation-cache break, and cover it with a
record-to-replay test.

### Persisted permission and configuration audit

Search persisted tool-name consumers before landing the rename. If permission
rules or settings store exact tool names, recognize `Apply_patch` as an alias for
`apply_patch` at read/match time. Do not mutate the user's live settings as part
of this change.

## Replay and decision gates

### Replay driver

Add a read-only replay driver such as `scripts/replay-apply-patch.ts`. It should
accept explicit transcript/session inputs, reconstruct only states it can prove,
and produce bounded aggregate output. It must not modify source files, session
JSONL, or live settings.

Compare at least:

- current per-hunk uniqueness behavior;
- historical first-forward cursor behavior;
- unique complete-plan behavior with exact mutation matching;
- unique complete-plan behavior under the current tolerant ladder, for
  measurement only.

Replay complete envelopes, not isolated operations. Include all later hunks,
adds, deletes, moves, and independent operations. Count unreconstructable cases
as unknown.

The corpus includes:

- reconstructable calls from the supplied 68-call session;
- the historical replayable ambiguity corpus;
- successful calls, especially those accepted only by tolerant matching;
- adversarial repeated and nested blocks;
- misleading preceding hints;
- an ambiguous early hunk resolved by a later fence;
- generated text that duplicates a later anchor;
- exact and approximate candidates competing at different locations;
- BOF, hard EOF, CRLF, BOM, and no-final-newline cases.

### Adjudication

For sampled or disputed calls, record separately:

- intended file and region;
- replacement fidelity;
- resulting task correctness;
- safe rejection;
- wrong-region application;
- correct placement with corrupted replacement;
- order-independent alternatives;
- unknown intent.

Subsequent committed code is supporting evidence, not automatic ground truth.
Placement notes do not turn a wrong mutation into a correct one.

### Matching-policy gate

The target remains exact-authority and diagnostic-only tolerance unless evidence
shows that exact matching causes unacceptable task-level regression without a
corresponding correctness benefit.

Any amendment must name the permitted normalization, the patch-line kinds it
may affect, and why it cannot change program meaning in the accepted case. A
possible amendment such as context-only trailing-whitespace tolerance is not
pre-approved by this plan.

### Release blockers

Do not ship the new planner when any of these remains:

- a consequential wrong-region placement introduced in adjudicable replay;
- a case where incomplete search is reported as unique;
- a preflight failure that publishes any operation;
- old transcripts no longer render or resume;
- old patch calls replay as ordinary JSON function calls instead of custom calls;
- grammar and parser disagree on canonical examples;
- a hard EOF hunk can fall back to the interior;
- generated text can anchor a later hunk;
- prompt and runtime semantics describe different hint behavior;
- model evaluation shows repeated unrecoverable exact-match failures without
  useful diagnostics.

## Tests

### Parser and grammar

Extend `parser.test.ts` and add grammar contract tests for:

- required opening and closing envelope markers;
- raw narrative before or after the envelope;
- add, delete, update, and move headers;
- bare and stacked `@@` hints;
- literal marker-like text when correctly prefixed as hunk content;
- empty and blank lines;
- hard EOF placement;
- valid and invalid no-newline marker attachment;
- CRLF tool input;
- recognized historical wrapper input;
- grammar/parser acceptance agreement for canonical fixtures.

The serialized OpenAI schema test must assert the canonical name and real Lark
grammar, not only that a grammar object exists.

### Planner

Add focused `planner.test.ts` coverage for:

- one exact candidate per hunk;
- local ambiguity resolved by later explicit context;
- unresolved ambiguity for first and later hunks;
- zero complete ordered plans;
- candidates that exist only before the previous consumed range;
- overlapping consumed ranges;
- repeated hints and stacked hint ordering;
- hint text preceding a sibling rather than containing the hunk;
- no matching against text added by an earlier hunk;
- hard BOF and EOF behavior;
- planner count saturation at `many`;
- resource-limit failure without guessed placement;
- deterministic plan and diagnostic coordinates.

### Pure application

Update `applier.test.ts` so it verifies planning against the original snapshot
and application from the completed plan. Replace tests that encode mutated-buffer
search or per-hunk early rejection. Preserve tests for operation independence,
buffer metadata, bounded results, and no mutation on preflight failure.

Add assertions that tolerant diagnostic candidates never authorize a write.

### Tool and filesystem boundary

Extend `FilePatchTool.test.ts` and `FilePatchTool.permissions.test.ts` for:

- one failed hunk causes zero publication across all files;
- other independently plannable operations are reported only as preflight
  evidence;
- execution snapshot conflict immediately before publication;
- move destination race;
- complete rollback and incomplete recovery outcomes;
- settings, secrets, notebook, path alias, and bare deletion safeguards;
- bounded success placements and failure candidates;
- no whole-file source leakage in persisted output.

### Rename and continuation

Cover both canonical generation and legacy consumption in:

- `src/utils/providerPromptRegressions.test.ts`
- `src/constants/promptAssembly.snapshot.test.ts`
- `src/constants/prompts.test.ts`
- `src/services/api/codex-fetch-adapter.test.ts`
- `src/services/api/codex-item-canonicalization.test.ts`
- `src/services/api/codex-continuation-e2e.test.ts`
- `src/services/autoDream/autoDream.test.ts`
- `src/services/extractMemories/extractMemories.test.ts`
- `app/sidecar/readPeerTool.test.ts`
- `app/renderer/src/transcriptProjector.test.ts`

Required cases include:

- new schema advertises only `apply_patch`;
- new raw input records and replays as `custom_tool_call`;
- old `Apply_patch` raw and `{ ops }` inputs retain custom-call replay;
- old results still project as the patch tool family;
- new prompts contain `apply_patch` and not accidental `Apply_patch`;
- legacy literals remain only in compatibility tests, constants, and explicit
  historical documentation.

## Verification commands

Run focused checks while implementing:

```sh
bun test src/tools/FilePatchTool/parser.test.ts
bun test src/tools/FilePatchTool/planner.test.ts
bun test src/tools/FilePatchTool/applier.test.ts
bun test src/tools/FilePatchTool/FilePatchTool.test.ts
bun test src/tools/FilePatchTool/FilePatchTool.permissions.test.ts
bun test src/utils/providerPromptRegressions.test.ts
bun test src/services/api/codex-fetch-adapter.test.ts
bun test src/services/api/codex-item-canonicalization.test.ts
bun test src/services/api/codex-continuation-e2e.test.ts
bun test app/sidecar/readPeerTool.test.ts
bun test app/renderer/src/transcriptProjector.test.ts
```

Before considering the implementation complete:

```sh
bun run build:dev:full
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app renderer:build
git diff --check
bun run maps:lint
```

Do not use bare `bun test`; repository account suites require file-isolated
routing. Live model and old-session resume checks require explicit authorization
because they consume real account capacity and touch live session state.

## Implementation slices

The slices are dependency boundaries, not permission to ship partially aligned
prompt and runtime contracts.

### Slice 1: replayable pure semantics

- Add immutable source-coordinate types.
- Add the pure planner and planner tests.
- Add pure plan application.
- Retain the existing production matcher until comparative replay is available.
- Add the replay driver and produce an evidence report.

Exit condition: complete-envelope replay can compare current, first-forward, and
unique-plan outcomes without filesystem mutation.

### Slice 2: syntax and diagnostics

- Add source spans and side-specific newline representation.
- Add structured planner failures and divergence-centered diagnostics.
- Add the canonical grammar and grammar/parser contract tests.
- Rewrite the prompt against the decided contract.

Exit condition: parser, grammar, prompt, planner, and diagnostics describe the
same language and placement semantics.

### Slice 3: name and history migration

- Make `apply_patch` canonical.
- Add legacy-name recognition at persisted-history boundaries.
- Update prompts, UI labels, snapshots, peer summaries, memory extraction, and
  adapter tests.
- Verify old-session record/replay locally and, with authorization, against the
  live backend.

Exit condition: new calls are lowercase and historical uppercase calls remain
usable without advertising two tools.

### Slice 4: production integration

- Select the gated matching policy.
- Wire the planner and pure applier into `FilePatchTool` preflight.
- Preserve all-or-nothing publication and existing rollback machinery.
- Add bounded placement metadata and updated model results.
- Run the focused and package verification suites.

Exit condition: all release blockers are cleared and the implementation matches
the locked contract or a documented evidence-based amendment.

### Slice 5: model-in-the-loop evaluation

Run representative edits using the actual new name, grammar, prompt, Read
surface, diagnostics, and result projection. Measure:

- first-attempt correct placement;
- safe rejection rate;
- retry turns and repeated failures;
- wrong-region edits;
- replacement corruption;
- total task correctness;
- behavior after compaction and old-session resume.

Exit condition: no unresolved consequential wrong placement and no usability
regression that makes the exact contract impractical for the supported GPT
models.

## Success criteria

- The canonical tool is `apply_patch` everywhere new behavior is emitted.
- Historical `Apply_patch` calls still render, classify, and replay.
- A complete ordered update is accepted exactly when it has one authorized
  placement plan.
- Later explicit context can resolve earlier local ambiguity.
- Unresolved ambiguity never falls back to the first candidate.
- Placement never searches replacement text introduced by the same update.
- EOF and no-newline constraints are enforced on the correct source side.
- Tolerant matches never authorize production mutation unless an evidence-based
  amendment changes this plan.
- Any preflight failure publishes no files.
- Publication safeguards and recovery outcomes retain existing coverage.
- Failure output identifies the obstacle and useful candidate divergence within
  bounded output.
- Prompt, grammar, parser, runtime behavior, saved-session compatibility, and UI
  rendering pass their joint regression suite.

## Rollback and recovery

Keep the planner and integration changes in coherent commits so the production
switch can be reverted without removing replay fixtures or evidence tooling.

If the new matcher fails release gates, retain the current production placement
policy while keeping behavior-neutral diagnostics, replay infrastructure, and
legacy-name tests where safe. Do not restore greedy first-forward placement as
an emergency fallback.

If the lowercase name causes a backend continuation incompatibility, keep new
sessions on `apply_patch`, route old-name history through an adapter-level
compatibility path, and accept a bounded cache reset where necessary. Do not
rewrite saved transcripts or expose both names to the model without a separate
review.
