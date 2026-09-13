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
- Register `Apply_patch` as an alias on the canonical `FilePatchTool` so shared
  `findToolByName` consumers, including terminal transcript rendering, resolve
  historical calls to the current tool definition.
- A shared predicate recognizes the canonical and legacy names at raw persisted
  history boundaries that do not have a `Tool` registry available.
- Permission-rule parsing normalizes the legacy name to the canonical name at
  read and match time. Existing stored rules are not rewritten.
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
- `@@` text containing a non-whitespace character is a mandatory
  preceding-line constraint. Its authoritative comparison is case-sensitive,
  trimmed whole-line equality:
  `sourceLine.trim() === hint.trim()`.
- Trimming ignores leading indentation and trailing whitespace only. It does
  not normalize internal whitespace, punctuation, Unicode, or case.
- A whitespace-only hint is equivalent to bare `@@` and contributes no stacked
  constraint.
- This deliberately narrows the current
  `sourceLine.trim().includes(hint.trim())` behavior. For example,
  `@@ function foo` no longer matches `function foobar()` or
  `function foo() {`; the model must copy the complete logical source line.
- It is not a class, function, indentation, or AST containment promise.
- Stacked hints must appear on distinct source lines in their supplied order.
- Hints are evaluated against the immutable source snapshot.
- A hint witness may be on the candidate's first fingerprint line. In source
  coordinates, the final hint line must be at or before `sourceStart`; preserve
  the current inclusive boundary rather than changing it to strictly before.
- A hint supplies no implicit lower boundary. When a lower boundary matters,
  the patch must provide later literal context.
- Missing hints never fall back to an unhinted match.
- Hint-witness choices are diagnostic evidence, not placement identity. If
  several matching hint lines justify the same hunk source range, deduplicate
  that range before complete-plan counting and select one witness chain
  deterministically for diagnostics.

### Boundaries and insertions

- A context-free first hunk without EOF retains BOF insertion semantics.
- A context-free EOF hunk appends.
- Other insertion positions require literal old-side context.
- `*** End of File` is a hard constraint. A fingerprinted EOF hunk must consume
  through source EOF, and an EOF hunk must be last in its update.
- There is no interior fallback for an EOF-marked hunk.
- No-newline markers carry explicit old-side and new-side meaning based on the
  preceding patch line. Old-side state is validated against source EOF.
- New-side no-newline state is a constraint on the final output of the complete
  plan, not merely the local hunk. A later deletion-only hunk may remove the
  remaining source tail and make the marked new-side line the output EOF; this
  is valid. Any later hunk that leaves or adds output after that line makes the
  plan invalid. Evaluate this before deciding whether there are zero, one, or
  many complete plans.
- A no-newline marker attaches only to the immediately preceding hunk line. A
  marker after a deletion constrains the old side, after an addition constrains
  the new side, and after context constrains both sides. Preserve that line
  attachment in the parsed representation.
- Marker absence is intentionally asymmetric. On the old side it is
  unspecified, so a patch need not know whether the source snapshot has a final
  newline. On the new side, an unmarked patch line that becomes the nonempty
  final output line requires a final newline. If no hunk affects output EOF,
  preserve the source's existing final-newline state. Empty output is exactly
  zero bytes and has no newline state.
- Unaffected source bytes, BOM state, encoding, and line-ending style remain
  preserved to the extent already supported by `readFileForEdit` and the
  publication helpers.

Expected logical bytes (`\n` below means LF before line-ending serialization):

| Source bytes | EOF-affecting hunk | Marker placement | Expected outcome |
| --- | --- | --- | --- |
| `old` | replace `-old` with `+new` | none | `new\n` |
| `old` | replace `-old` with `+new` | after `-old` only | `new\n` |
| `old\n` | replace `-old` with `+new` | after `-old` only | reject: old-side newline conflict |
| `old` | replace `-old` with `+new` | after `+new` only | `new` |
| `old` | replace `-old` with `+new` | after both lines | `new` |
| `old` | add `+prefix` before final context ` old` | none | `prefix\nold\n` |
| `old` | add `+prefix` before final context ` old` | after context | `prefix\nold` |
| `old` | context-free EOF append `+new` | none | `old\nnew\n` |
| `old` | context-free EOF append `+new` | after `+new` | `old\nnew` |
| `old` | delete the only line | none or valid old-side marker | empty bytes |
| absent file | add file containing `+new` | none | `new\n` |
| absent file | add file containing `+new` | after `+new` | `new` |

The same table applies to CRLF files after logical planning, with serialization
restoring CRLF separators. A marker is a constraint, not a request to rewrite
an unrelated source line's bytes.

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
  newline:
    | {
        kind: 'canonical'
        markers: Array<{
          afterHunkLine: number
          appliesTo: 'old' | 'new' | 'both'
          sourceSpan: PatchSourceSpan
        }>
      }
    | {
        kind: 'legacy-output'
        outputAtEof: 'present' | 'absent'
      }
  sourceSpan?: PatchSourceSpan
}
```

Names may vary during implementation, but the representation must preserve
patch-source locations, the exact preceding patch line, and old-side versus
new-side newline meaning for canonical raw input. `sourceSpan` is absent only
for structured legacy input that never contained raw patch coordinates;
diagnostics must not invent a line number for it.

For compatibility, prefer preserved raw patch input and reparse it whenever it
is available. A legacy structured `{ ops }` update containing only
`noNewlineAtEndOfFile` cannot recover marker side or attachment. Normalize it
using its historical execution meaning: `true` is an output-level instruction
that the hunk produce no final newline when it determines output EOF; `false`
uses the default final-newline behavior. Neither value supplies old-side
newline evidence. Add-file legacy metadata remains an unambiguous output-level
instruction. If a future operation requires old-side evidence that exists only
in discarded legacy metadata, reject with a stable
`PATCH_LEGACY_NEWLINE_AMBIGUOUS` error and instruct the caller to resend the raw
canonical envelope; never infer that evidence from the legacy boolean.

### Placement evidence

Add a pure placement module, preferably
`src/tools/FilePatchTool/planner.ts`, with no filesystem access and no prose
formatting. Its useful concepts are:

```ts
type HunkCandidate = {
  hunkIndex: number
  sourceStart: number
  sourceEnd: number
  boundary: 'none' | 'bof' | 'eof'
  matchTier: 'exact'
  diagnosticHintLines?: number[]
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

Candidate and plan identity is the ordered set of hunk source ranges, boundary
semantics, and edits. The particular hint lines used to prove a mandatory hint
constraint do not create distinct candidates or plans. Candidate discovery must
deduplicate this identity before the dynamic program runs; diagnostic witness
lines are selected separately and deterministically.

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
insertions consume their supplied context. Source-consuming ranges must not
overlap. Zero-width candidates may share a source boundary with one another or
with a consuming range when patch order is consistent. At a shared coordinate,
inserted output appears in patch hunk order. This includes BOF followed by EOF
on an empty file. A reverse-application implementation therefore breaks equal
`sourceStart` ties by descending hunk index; a streaming implementation must
produce the same bytes.

### Planner and diagnostic resource budgets

Make resource limits explicit inputs to the pure planner rather than a single
late DP guard. At minimum, account separately for:

- source positions scanned during candidate discovery;
- candidate identities retained per hunk and in total;
- hint-line comparisons and witness searches;
- dynamic-program transitions and predecessor storage;
- approximate comparisons used only to construct diagnostics.

Every potentially superlinear loop must charge one of these counters. Exhausting
a planning counter before the result is proven returns a stable
`PATCH_PLANNER_LIMIT` failure and authorizes no mutation; partial search is never
reported as unique. Exhausting the separate diagnostic budget preserves the
original parser or planner failure, sets bounded `diagnosticsTruncated` metadata,
and omits further near-match detail. It must not replace a useful primary error
with a planner-limit error.

### Pure application

Replace mutated-buffer searching in `applyUpdateHunks` with two operations:

1. Plan every hunk against the original logical source lines.
2. Apply the chosen source-coordinate edits from the end of the file backward,
   or stream once through the source using the complete ordered plan.

Application must copy unchanged/context source bytes from the source snapshot,
not from the patch text. Added text comes from the patch. It must assert that the
plan is ordered and non-overlapping even though the planner already guarantees
those properties. New-side EOF and final-newline validation uses the fully
planned output, before it is returned for publication.

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

### `src/tools/FilePatchTool/FilePatchTool.tsx`

- Register `aliases: [LEGACY_FILE_PATCH_TOOL_NAME]` on the canonical tool
  definition. This is consumption compatibility only; aliases must not cause a
  second schema or prompt-visible tool to be emitted.
- Keep current permission checks, mutation locks, execution snapshot capture,
  settings and secret validation, publication ordering, and rollback machinery.
- Feed immutable `currentFiles` snapshots into the planner/applier.
- If any operation fails planning or validation, publish none.
- Preserve bounded independent-operation failure aggregation.
- Project optional placement metadata into the persisted result and model-facing
  success message.
- Change user-visible tool wording to `apply_patch`.

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
- Parse every no-newline marker with its immediately preceding hunk-line index
  and derived side (`old`, `new`, or `both`); validate attachment and duplicate
  side claims without collapsing markers to one boolean. The planner validates
  whether the attached line actually reaches the corresponding EOF.
- Reparse preserved raw legacy input when available. Keep the historical
  structured-only output directive separate from canonical marker evidence and
  reject with `PATCH_LEGACY_NEWLINE_AMBIGUOUS` if unavailable old-side evidence
  ever becomes required.
- Keep full-envelope fail-closed behavior.
- Keep canonical parsing and historical wrapper normalization visibly separate.

### `src/tools/FilePatchTool/planner.ts` (new)

- Enumerate exact candidates against immutable source lines.
- Evaluate textual hints, ordering, non-overlap, BOF, EOF, and newline
  constraints.
- Match effective hints using case-sensitive trimmed whole-line equality; never
  use substring, fuzzy, or internal-whitespace matching for authorization.
- Preserve inclusive hint semantics: a hint may match at the candidate's first
  fingerprint line.
- Deduplicate source-range/edit candidates before counting; keep deterministic
  hint witness lines only as diagnostic evidence.
- Evaluate output-side no-newline constraints on the completed plan, including
  later deletion-only hunks that make an earlier marked line the final line.
- Require every canonical marker's attached line to reach source EOF on its old
  side and final output EOF on its new side.
- Preserve patch order for zero-width insertions at the same source coordinate.
- Count complete plans as zero, one, or many.
- Charge explicit scan, retained-candidate, hint, DP-transition, and predecessor
  budgets; return structured and bounded planner-limit failures.
- Expose test-only comparison policies needed by replay without exposing a
  runtime force option to the model.

### `src/tools/FilePatchTool/applier.ts`

- Retain operation-level in-memory aggregation and atomic failure behavior.
- Replace `findHunkPosition`, mutated-buffer cursor matching, and mutation-time
  hint searches with planner consumption.
- Apply a completed plan without re-searching.
- Preserve patch order when reverse-applying multiple edits at one source
  coordinate, and validate new-side EOF state against the complete output.
- Preserve buffer encoding and line-ending metadata.
- Move prose diagnostics to the diagnostic owner.

### `src/tools/FilePatchTool/diagnostics.ts` (new)

- Render structured parser/planner failures into bounded `FilePatchError`
  messages and model metadata.
- Implement divergence-centered long-line diagnostics.
- Keep approximate matching here unless replay infrastructure needs the same
  diagnostic helpers.
- Use a budget independent from authoritative planning. On exhaustion, retain
  the primary failure and mark diagnostic detail as truncated.

### `src/tools/FilePatchTool/types.ts`

- Add parser spans, planner evidence, side-specific newline state, placement
  metadata, and stable error metadata.
- Keep legacy `before`, `after`, and `notes` fields optional for old transcript
  rendering.
- Normalize legacy structured input instead of requiring old stored calls to
  contain new fields.

### `src/tools/FilePatchTool/prompt.ts`

- Generate the name from `FILE_PATCH_TOOL_NAME`.
- Explain whole-update uniqueness rather than per-hunk uniqueness.
- Describe `@@` text as a complete source line matched after outer-whitespace
  trimming, never a substring or containing scope.
- State exact-match mutation authority and diagnostic-only approximate matches.
- State hard EOF, explicit no-newline marker attachment/defaults, and
  all-or-nothing call behavior.
- Restore concrete examples with sufficient consecutive context, ordered hunks,
  repeated blocks resolved by later context, and an ambiguity that must reject.
- Keep the description concise enough not to erase the benefit of constrained
  generation.

### Historical-name consumers

Audit every exact comparison. Where a current tool registry is available, rely
on the registered alias through `findToolByName`; where code inspects raw
persisted records without a registry, use `isFilePatchToolName`. Important
owners include:

- `src/components/messages/AssistantToolUseMessage.tsx`
- `src/services/api/codex-fetch-adapter.ts`
- `src/utils/messages.ts`
- `src/services/autoDream/autoDream.ts`
- `src/services/extractMemories/extractMemories.ts`
- `app/sidecar/readPeerTool.ts`
- `app/renderer/src/transcriptProjector.ts`

New tool selection, prompt assembly, and tool schema emission use only the
canonical constant. Comments, test names, snapshots, and model-facing prose are
updated to lowercase unless they explicitly describe legacy data.

### `src/utils/permissions/permissionRuleParser.ts`

- Add `Apply_patch` to the shared legacy-to-canonical permission-name map using
  the exported file-patch constants.
- Cover bare rules and content-bearing rules so an existing
  `Apply_patch(...)` permission continues to match `apply_patch` without
  rewriting the stored rule.

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
  measurement only;
- current trimmed-substring hint filtering versus the proposed trimmed
  whole-line rule;
- canonical raw newline-marker semantics versus structured-only legacy output
  directives.

Replay complete envelopes, not isolated operations. Include all later hunks,
adds, deletes, moves, and independent operations. Count unreconstructable cases
as unknown.

The corpus includes:

- reconstructable calls from the supplied 68-call session;
- the historical replayable ambiguity corpus;
- successful calls, especially those accepted only by tolerant matching;
- adversarial repeated and nested blocks;
- misleading preceding hints;
- substring-colliding, indentation-varied, and whitespace-only hints;
- an ambiguous early hunk resolved by a later fence;
- generated text that duplicates a later anchor;
- exact and approximate candidates competing at different locations;
- BOF, hard EOF, CRLF, BOM, and no-final-newline cases;
- each row of the expected-byte newline table, plus legacy structured forms
  whose original marker side is unrecoverable.

### Evidence accounting and minimum floor

Freeze an evaluation manifest before interpreting candidate results. It records
the corpus window, call identifiers, reconstruction method, comparison policies,
adjudication labels, fixed model tasks, supported model/provider configurations,
repeat count, and acceptance thresholds. Current and candidate implementations
must run against the same manifest; failures must not be removed after results
are known.

Report both the full cohort denominator and the adjudicable denominator. Every
one of the 68 supplied-session calls and 48 historical ambiguity failures must
be classified as replayed or unknown, with an enumerated reason such as missing
working-tree state or an out-of-repository target. Unknown is never counted as
success, failure, or evidence for uniqueness.

The matching-policy gate is unresolved unless all of these minimums are met:

- every reconstructable call in the frozen cohorts is replayed as a complete
  envelope, not as a selected operation;
- at least 20 complete-envelope ambiguity cases are adjudicable, including both
  known dangerous first-hunk cases and at least 15 non-first-hunk cases; extend
  the corpus window or add newly captured, provenance-preserving cases if
  complete-envelope reconstruction reduces the current 25-case corpus below
  this floor;
- at least 30 complete-envelope successful updates that require a non-exact
  tier under the current matcher are adjudicable, with at least five examples
  for every non-exact tier whose removal is being evaluated; extend the fixed
  historical window if necessary rather than substituting ordinary exact
  successes;
- each fixed model task is run at least three times under both contracts for
  every supported model/provider configuration in the release set, with at
  least 30 update attempts per contract and configuration.

Before execution, the manifest must define what counts as task success, safe
rejection, recoverable retry, replacement corruption, and consequential
wrong-region placement. The candidate must produce zero consequential
wrong-region placements, no lower final task-correctness rate than the current
contract on the paired model suite, and no increase in unrecoverable failures in
the tolerant-success cohort. Retry count and first-attempt rejection are
reported as usability costs, not silently folded into correctness. If the
minimum coverage or any predeclared threshold is not met, keep the production
matching policy unchanged and record the gate as unresolved rather than
declaring the refactor safe.

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
- a canonical newline marker loses its preceding-line or side attachment;
- a legacy structured newline boolean is treated as old-side evidence;
- generated text can anchor a later hunk;
- a partial-line hint match authorizes placement;
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
- no-newline markers after deletion, addition, and context lines, preserving
  their old/new/both-side attachment and patch-source line;
- invalid unattached, duplicate, and misplaced no-newline markers;
- CRLF tool input;
- recognized historical wrapper input;
- raw legacy input reparsing and structured-only legacy newline normalization
  without invented old-side evidence;
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
- trimmed whole-line hint equality, including substring collisions,
  indentation-only differences, trailing whitespace, internal whitespace, case,
  and whitespace-only hints;
- candidates on lines 1 and 5 where a same-line hint at line 1 must remain
  eligible under the inclusive at-or-before boundary;
- multiple valid hint-witness chains for one source range count as one candidate
  and one plan, with deterministic diagnostic witnesses;
- hint text preceding a sibling rather than containing the hunk;
- no matching against text added by an earlier hunk;
- hard BOF and EOF behavior;
- output-side no-newline validity that becomes true only after a later
  deletion-only hunk removes the source tail, plus the rejecting case where a
  later hunk leaves or adds output after the marked line;
- BOF then EOF insertion on an empty file, same-coordinate insertions, and
  insertion/consuming-hunk boundary ties, all preserving patch order;
- planner count saturation at `many`;
- resource-limit failure during candidate scanning, candidate retention, hint
  evaluation, and DP transitions without guessed placement;
- diagnostic-budget exhaustion that preserves the primary failure and reports
  truncated detail;
- deterministic plan and diagnostic coordinates.

### Pure application

Update `applier.test.ts` so it verifies planning against the original snapshot
and application from the completed plan. Replace tests that encode mutated-buffer
search or per-hunk early rejection. Preserve tests for operation independence,
buffer metadata, bounded results, and no mutation on preflight failure.

Add assertions that tolerant diagnostic candidates never authorize a write.
Turn the expected-byte newline table above into parameterized tests covering
marker absence, old-only, new-only, both-side, and context markers; context-free
append to an unterminated file; deletion to an empty file; CRLF serialization;
and preservation when no planned hunk affects output EOF.

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

- `src/Tool.test.ts`
- `src/utils/permissions/permissions.test.ts`
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
- old `Apply_patch` calls resolve through the shared tool registry and render in
  `AssistantToolUseMessage` after only `apply_patch` is advertised;
- stored bare and content-bearing `Apply_patch` permission rules normalize to
  and match the canonical tool;
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
bun test src/Tool.test.ts
bun test src/utils/permissions/permissions.test.ts
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
- Canonical newline markers retain their attached patch line and legacy
  structured booleans retain only their historical output-level meaning.
- Effective hints authorize candidates only by trimmed whole-line equality.
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
