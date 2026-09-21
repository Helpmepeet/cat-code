# Cat Code `apply_patch` Interview Preparation

Status: checkpoint, 2026-09-19

This is an interim study checkpoint, not the final interview note. The
overview link will be added only during the final wrap-up.

## Current central understanding

Cat Code did not replace the old Claude-style edit tool because the old tool
was universally bad. The initial reason was model-tool alignment: GPT models
were associated with the Codex `apply_patch` dialect, while the inherited
Claude tool used an `old_string` and `new_string` contract.

The strongest evidence for the change came from two separate artifacts:

- A GPT-5.4 session produced six old `Edit` failures: four no-ops caused by
  byte-identical `old_string` and `new_string` values, plus two ambiguous
  matches.
- A separate `apply_patch` evaluation recorded 7/13 first-try successes.
  Those failures were mostly malformed hunks, wrong anchors, ambiguity, and
  fixture state issues. They were not the same four no-op cases.

The honest interview framing is:

> `apply_patch` was a provider-specific model-interface optimization, not a
> claim that the old edit tool was inherently inferior.

## The old Claude `Edit` tool

The model-facing input was a strict one-file replacement object:

```json
{
  "file_path": "/repo/src/config.ts",
  "old_string": "const TIMEOUT_MS = 3000",
  "new_string": "const TIMEOUT_MS = 5000",
  "replace_all": false
}
```

Its core behavior was:

1. Read the target file.
2. Find `old_string`.
3. Fail if it is absent.
4. Fail if it occurs more than once and `replace_all` is false.
5. Replace it with `new_string`.
6. Write the file.

It was conceptually:

> Find this exact string and replace it with that string.

The tool had useful safety behavior, including read and stale-file checks,
permissions, mutation locks, settings validation, and guarded writes. Its
weakness was the model-facing contract: the model had to reconstruct an exact
old block, and the contract did not naturally express multi-file patches,
explicit hunks, moves, or file deletion.

## The GPT/Codex-style patch language

The patch language is not primarily a JSON object. It is a bounded text
language passed as the input to a custom/freeform tool.

```text
*** Begin Patch
*** Update File: src/config.ts
@@
 const PORT = 3000
-const TIMEOUT_MS = 3000
+const TIMEOUT_MS = 5000
*** End Patch
```

The markers mean:

- `*** Begin Patch`: start the envelope.
- `*** Update File: ...`: modify an existing file.
- `@@`: start a hunk.
- A leading space: unchanged context.
- `-`: delete an old source line.
- `+`: add a new line.
- `*** End Patch`: finish the envelope.

The core syntax is shared with Cat Code. Cat Code also supports add, delete,
move, EOF, and newline-related constructs, plus compatibility input forms.

The important distinction is:

> The patch text is the language. Cat Code's parser, planner, permission
> system, and filesystem code define the meaning and safety of that language.

## Schema versus semantics

The model-facing syntax can remain similar while runtime behavior changes
substantially.

The current Cat Code path is approximately:

```text
model patch text
  -> parse syntax
  -> normalize operations
  -> validate input and permissions
  -> acquire mutation locks
  -> read current snapshots
  -> plan all operations in memory
  -> validate planned results
  -> recheck files immediately before publication
  -> write, delete, or move files
  -> rollback when possible after publication failure
  -> return bounded result and diagnostics
```

Therefore, changing the implementation after parsing can change:

- how a hunk is located;
- whether ambiguity is accepted;
- whether later hunks can disambiguate earlier ones;
- whether multiple files are preflighted together;
- whether a concurrent change is rejected;
- whether partial mutations are recovered;
- what the model sees after failure.

## Historical matcher versus current planner

The historical Cat Code matcher behaved more like a sequential search:

```text
for each hunk:
    search the current buffer
    choose a matching location
    modify the buffer
    continue from after that location
```

It retained tolerant matching tiers and cursor behavior. In particular, later
non-first hunks could select the first eligible match after the cursor. That
made patches more tolerant, but it could turn uncertainty into a successful
edit in the wrong repeated region.

The current production planner behaves differently:

```text
for the complete patch:
    find all candidate placements against the original source
    enforce hunk order and non-overlap
    include newline constraints
    count complete valid plans
    accept only one valid plan
```

The current planner:

- uses immutable source coordinates;
- uses exact context and deletion lines as the old-side fingerprint;
- treats hints as whole-line constraints;
- allows later hunks to disambiguate earlier ones;
- never searches text introduced by an earlier hunk;
- rejects zero valid plans;
- rejects multiple valid plans;
- uses approximate matches only for bounded diagnostics, never authorization.

The most important behavioral change is:

> The old approach selected a location while walking the patch. The current
> approach proves that the complete patch has exactly one valid interpretation
> before mutation.

## What strictness is protecting

Strictness is not automatically better. Different checks protect different
properties:

| Check | Main property protected |
| --- | --- |
| Grammar validation | Well-formed input |
| Unique hunk placement | Semantic correctness |
| Path permissions and secret checks | Security and authorization |
| Snapshot and identity checks | Concurrent-write integrity |
| Preflight before publication | Avoiding partial planned failure |
| Rollback | Recovery after publication failure |
| Bounded diagnostics | Model recovery and observability |

The most defensible reason to reject an ambiguous hunk is that a visible retry
is usually cheaper than a silent edit in the wrong function. However, every
rejection has a service cost: latency, model tokens, user frustration, and
implementation complexity.

The correct optimization target is not maximum strictness. It is the best
trade-off between:

- silent wrong edits;
- lost concurrent changes;
- partial patch damage;
- false rejection and retries;
- latency and cost;
- maintenance complexity.

## Codex CLI comparison from the research checkpoint

The external Codex CLI research supplied during this session should be treated
as source-backed research to verify, not as Cat Code source authority.

Its central claim is that public Codex CLI separates three layers:

```text
patch language
  -> apply_patch interpreter
  -> host security and filesystem controls
```

The research describes Codex's public matcher as tolerant, forward-cursor-
based, and first-match-wins. It says Codex protects writable paths through
host sandbox, approval, and filesystem controls, but does not publicly show a
complete-envelope ambiguity solver, final-write content CAS, or cross-file
transaction.

That would mean Codex prioritizes patch tolerance and host authorization while
accepting some semantic and transactional risk. Cat Code chooses a more
conservative point for placement and concurrent-write correctness.

The precise comparison is:

| Dimension | Codex-style behavior described by research | Cat Code current behavior |
| --- | --- | --- |
| Patch syntax | Bounded custom/freeform patch language | Similar core language and bounded grammar |
| Placement | Tolerant forward search, first acceptable match | Exact complete-envelope plan |
| Ambiguity | More likely to select a candidate | Rejects multiple valid plans |
| Later-hunk disambiguation | Not used to backtrack earlier placement | Used by the planner |
| Concurrent content changes | No public final-write CAS found | Content and file-identity rechecks |
| Multi-file failure | Sequential committed prefix may remain | Best-effort rollback after publication |
| Security boundary | Host sandbox, approval, writable-path checks | Host controls plus tool-specific checks |
| Trade-off | Fewer retries, more semantic uncertainty | More retries, less silent corruption risk |

The careful interview statement is:

> Codex trusts the model more for semantic placement inside an authorized
> file. Cat Code treats placement as untrusted input and requires a unique
> plan. Both still need host-side permissions and sandbox controls.

## What remains to study

The next teaching topic should be:

> Parsing versus planning versus applying.

After that, study these in order:

1. Add, delete, update, move, EOF, and newline semantics.
2. Multiple hunks and multiple files.
3. The exact preflight-before-mutation guarantee.
4. Stale snapshots, concurrent writes, locks, and file identity.
5. Atomicity and rollback limits.
6. Diagnostics and model recovery.
7. UI rendering, transcript persistence, and analytics.
8. Decision history and evaluation results.

## Evidence reviewed in Cat Code

Current source and tests:

- `src/tools/FilePatchTool/parser.ts`
- `src/tools/FilePatchTool/planner.ts`
- `src/tools/FilePatchTool/applier.ts`
- `src/tools/FilePatchTool/FilePatchTool.tsx`
- `src/tools/FilePatchTool/diagnostics.ts`
- `src/tools/FilePatchTool/prompt.ts`
- `src/tools/FilePatchTool/*test.ts`
- `src/tools.ts`
- `src/utils/api.ts`
- `src/services/tools/toolExecution.ts`
- desktop transcript and peer-tool projection code

Relevant Cat Code history:

- `86051a8e`: initial private apply_patch implementation.
- `8cf6d9a1`: permission-boundary, move, rollback, and mutation hardening.
- `5c68ebd2`, `3745f1cc`, `d0d87141`: bounded transcript/result persistence.
- `746005f7`, `d50bcaae`: historical ambiguity and cursor fixes.
- `7ee8fcc1`, `ba056787`: gated complete-envelope planner preparation.
- `74a571bc`: activated the complete-envelope planner in production.

Focused current FilePatchTool verification completed during the investigation:

```text
182 tests passed
0 tests failed
```
