# Apply_patch (FilePatchTool) subsystem review

Date: 2026-07-12
Scope: the full `Apply_patch` tool — `src/tools/FilePatchTool/` (parser, applier,
tool definition, UI, prompt), its wire path (`src/utils/api.ts`,
`src/services/api/codex-fetch-adapter.ts`, `src/utils/messages.ts`), the
permission plumbing shared with FileEditTool, and the design/eval/audit docs.
Method: source read + focused test run. No code changed by this review.
Evidence: `bun test src/tools/FilePatchTool/` → 30 pass / 0 fail (applier + parser suites).

## Update 2026-07-12 — adversarial verification + fixes implemented

A decorrelated ChatGPT verification pass (PR #9) confirmed every finding below
(none refuted) and surfaced four MISSED defects, the most serious an
**auto-mode classifier bypass** that F1 also causes. Fixes for F1 and M1–M4
landed in commit `8cf6d9a` with before/after tests; F2/F3 remain deferred, F5's
premise is now confirmed fact.

MISSED defects found by the verification pass:

- **M1 (BLOCKER, fixed)**: auto mode reruns `checkPermissions` under a synthetic
  `acceptEdits` context and skips the classifier on `allow`
  (`src/utils/permissions/permissions.ts:611-667`; Agent/REPL are the only
  exclusions). Chained with F1, every Apply_patch in auto mode — to any path —
  silently bypassed the classifier. Same root cause as F1; the `getPath` fix
  closes both.
- **M2 (MAJOR, fixed — two rounds)**: the `moveTo` destination skipped
  `validateInput` content checks (secret/deny keyed to the source path only) and
  was never read at call time, so the applier's target-exists guard was inert
  and a destination created after validation could be silently overwritten
  (TOCTOU). First fix added destination deny + secret scan and a call-time
  destination re-read that trips the guard. The re-review pass then found the
  destination checks were still (a) keyed to the source path for the notebook
  guard and (b) short-circuited by the source's UNC early-exit. Second fix
  centralizes destination validation into its own pass (`FilePatchTool.tsx`,
  after the per-operation loop): deny + existence + notebook + team-memory
  secret keyed to the destination, run independently of source-path early exits.
  Two destination cases are deliberately *not* schema-validated and this is
  correct, not a gap: a move requires an absent destination (errorCode 6), so a
  settings-file destination is always a new file where
  `validateInputForSettingsFileEdit` is a structural no-op (empty before-content)
  and is instead gated by the dangerous-path safety check in `checkPermissions`;
  and a UNC source can't be read to compute the moved content for a secret scan
  (its deny rule is still enforced at `checkPermissions`, which has no UNC skip).
- **M3 (MEDIUM, fixed)**: `rollbackAppliedFiles` had no per-file error
  isolation; a rollback failure aborted remaining recovery and propagated out,
  masking the original write error. Fixed: per-file try/catch, original error
  always rethrown.
- **M4 (MINOR, fixed)**: `prepareFileMutation` (mkdir + file-history) ran before
  the in-memory apply, leaving side effects on an anchor failure. Fixed:
  deferred until after the apply succeeds.

**F5 resolved**: upstream `openai/codex` ships a real `apply_patch.lark`
envelope grammar (`type: grammar`, `syntax: lark`), while cat-code sends the
catch-all `start: /(.|\n)*/`. So constrained decoding IS available upstream and
is forgone here; the 2026-07-11 instruction-stack audit's "grammar matches
upstream" claim is doc drift to correct. Adopting it stays a candidate (weigh
the one-time prompt-cache break), not yet done.

Still deferred: **F2** (session-vs-request provider keying of tool selection),
**F3** (approval-dialog case, envelope header label, per-file result
enumeration, `logFileOperation` mislabel).

## Verdict

The tool is good: the homefield-advantage rationale (give GPT models the
`apply_patch` V4A dialect they were trained on, instead of Claude's
`old_string`/`new_string` Edit) is correctly implemented at the two layers that
matter most — the wire protocol and the patch dialect — and the engineering
quality is high. But it has one real permission-boundary defect (F1, HIGH),
it is a second-class citizen in the approval/display UX (F3), and the
measurement that would prove the homefield advantage was planned twice and
never done (F4).

## What is genuinely right

**Wire fidelity.** `Apply_patch` is exported to OpenAI as a native freeform
custom tool with a Lark grammar (`src/utils/api.ts:73-78`, attached at
`src/utils/api.ts:207-211`), translated to `type: 'custom'` on the Codex wire
(`src/services/api/codex-fetch-adapter.ts:715-722`). The raw envelope text is
preserved end-to-end: an unparseable-as-JSON tool input is wrapped as
`{ input: <raw> }` only for this tool (`src/utils/messages.ts:2706-2707`), and
history replay emits `custom_tool_call` unconditionally with the recovered raw
string (`codex-fetch-adapter.ts:1185-1196`, `recoverApplyPatchInput` at
`codex-fetch-adapter.ts:872-886`) so replay byte-matches the server-recorded
baseline for prompt-cache stability. Streaming `custom_tool_call_input` deltas
are handled. All of this has regression tests (`src/utils/providerPromptRegressions.test.ts`,
`src/services/api/codex-fetch-adapter.test.ts`,
`src/services/api/codex-item-canonicalization.test.ts`).

**Format fidelity.** The 2026-04-30 alignment plan
(`docs/plans/2026-04-30-apply-patch-codex-alignment-plan.md`, "stop fighting
the model") is fully implemented: `@@` lines are stacked scope *disambiguators*,
not anchors; matching is the canonical 4-tier fuzzy cascade (exact → trimEnd →
trim → unicode normalization, `src/tools/FilePatchTool/applier.ts:240-245`)
mirroring Codex `seek_sequence`; `*** End of File` with tail-first search plus
full-scan fallback (`applier.ts:249-252`); BOF pure-insert as first hunk;
lenient parsing (marker trimming, blank-line tolerance, gpt-4.1 heredoc unwrap —
`src/tools/FilePatchTool/parser.ts:108-135`). Detail worth keeping: on a fuzzy
accept, context lines are written back as the original file bytes
(`applier.ts:169-171`), so a trim-tier match never corrupts the file.

**Robustness.** Two-phase apply — all operations validated and applied in
memory first, then written with reverse-order rollback on a failed write
(tested via forced unlink failure in `applier.test.ts`). Stale-read detection
at validate and call time, plus the `cachedFiles` check
(`applier.ts:277-292`) that turns an anchor miss into "the file changed on disk
since you read it — re-read", a better error than either Codex or Claude Edit
gives. Encoding/CRLF/no-trailing-newline metadata survive round trips,
including through `*** Move to:` (delete+add with metadata carry-forward,
`FilePatchTool.tsx:264-277`). Duplicate paths rejected both at parse time and
after `expandPath` normalization.

**Documented deviations from canonical Codex** (deliberate, with decision
trail): TitleCase tool name (settings-sharing rationale in
`docs/plans/2026-04-30-apply-patch-eval-report.md`); ambiguity → error with
remediation hint instead of Codex's silent first-match-from-cursor (safer; the
eval showed the model recovers by adding context); read-gate removed from
validation but kept as a system-prompt rule
(`src/constants/promptStyles/gpt.ts:154`).

## Findings, ranked

### F1 — HIGH: permission check runs against the wrong path; acceptEdits auto-allows patches to any file

`checkPermissions` calls
`checkSingleFileWritePermissions(FilePatchTool, { file_path }, …)` per target
path (`src/tools/FilePatchTool/FilePatchTool.tsx:98`), but that helper does
`path = tool.getPath(input)` (`src/utils/permissions/filesystem.ts:1237`) — and
FilePatchTool's `getPath` only understands the `ops` input arm
(`FilePatchTool.tsx:72-75`), so for `{ file_path }` it returns `''`.
`expandPath('')` resolves to the cwd (`src/utils/path.ts:53-56`), so every
per-file permission decision is made as if the target were the project
directory itself.

Verified impact chain:

- **acceptEdits bypass**: at `filesystem.ts:1388`,
  `pathInWorkingPath(cwd, cwd)` is true (`filesystem.ts:729-756`, same-path
  case), so in `acceptEdits` mode every patch target auto-allows — including
  files outside all working directories (e.g. `~/.zshrc`), where FileEditTool
  would ask.
- **Safety checks bypassed**: the dangerous-path checks
  (`checkPathSafetyForAutoEdit` at `filesystem.ts:1327` — `.git/`, `.vscode/`,
  `.idea/`, claude-config paths) are evaluated against cwd and never fire for
  patch targets.
- **Allow/ask rules mis-keyed**: rules match cwd instead of the real target —
  configured allow rules never apply (over-prompting in default mode), ask
  rules never fire.

Mitigations that still hold: deny rules are checked against the real path in
`validateInput` (`validateEditDenyRule` call at `FilePatchTool.tsx:131`);
settings files go through `validateInputForSettingsFileEdit`
(`FilePatchTool.tsx:200`); team-memory secret validation runs. But the
mode/safety/rule layers are effectively bypassed.

Same root cause, adjacent gaps: `preparePermissionMatcher` reads only
`ops[0]` (`FilePatchTool.tsx:85-88`), and `getPath` also returns `''` for the
`{ input: <envelope> }` arm — which is the only arm the GPT custom-tool path
ever produces.

Fix sketch: make `getPath` handle `{ file_path }` (the shared-helper contract
every other file tool honors) and parse the envelope arm (the parser is
available; wrap in try/catch). Boundary tests: "acceptEdits + target outside
cwd must ask"; "deny/allow rule matches the real target, not cwd".

### F2 — KNOWN/DEFERRED: tool selection keyed by session provider, wire format by request provider

`src/tools.ts:213-214` picks FilePatchTool vs FileEditTool from
`getAPIProvider()` (session-level), while the schema/prompt/custom-tool
attachment are keyed per-request via `resolveRequestProvider(options.model)`
(`src/utils/api.ts:165`). A GPT subagent inside an Anthropic session gets
Claude's Edit tool (homefield lost); a Claude subagent inside an OpenAI session
gets Apply_patch. Already finding-logged as deferred with a fix scope in the
2026-07-11 GPT instruction-stack audit (local doc, not yet committed as of this
writing); recorded here for completeness, not reopened.

### F3 — MEDIUM: second-class approval/display UX vs FileEditTool

- `src/components/permissions/PermissionRequest.tsx:47-81` has no case for
  FilePatchTool → GPT edit approvals render the generic
  `FallbackPermissionRequest`, not the file-edit diff dialog (compounded by
  F1's empty-path suggestions).
- The transcript header for the raw-envelope arm shows a generic label
  ("Update(patch)", no file path — `src/tools/FilePatchTool/UI.tsx:26-44`
  handles only the `ops` arm). The result view is fine (it renders
  `structuredPatch`). Cheap fix: `getToolUseSummary` try-parses the envelope.
- The model-facing result is just "Applied patch to N files."
  (`FilePatchTool.tsx:368-376`). Codex-native apply_patch enumerates affected
  files. With 4-tier fuzzy matching a patch can land somewhere slightly
  different from what the model imagined, and it gets zero confirmation of
  paths/ops. Cheap: list `A/M/D <path>` per file.
- `logFileOperation` records patch edits as `tool: 'FileEditTool'`
  (`FilePatchTool.tsx:351`) — analytics cannot distinguish patch edits from
  Edit edits.

### F4 — MEDIUM: the homefield advantage has never been measured post-alignment, and is invisible in production

- The only number on record is **7/13 first-try, pre-alignment**
  (`docs/plans/2026-04-30-apply-patch-eval-report.md`); the alignment plan
  targeted 13/13 and no post-alignment re-run is documented anywhere.
- The 2026-06-04 logging review
  (`docs/plans/2026-06-04-logging-review/apply-patch-editing.md`) prescribed a
  one-prefix fix (`[apply-patch]` in `ALWAYS_LOG_PREFIXES` + ~4 call sites) so
  fuzzy-tier rescues and failure codes (`PATCH_ANCHOR_NOT_FOUND` vs
  `PATCH_ANCHOR_AMBIGUOUS` vs changed-on-disk) become observable. The
  subsystem still contains zero log/telemetry calls (verified by grep across
  `src/tools/FilePatchTool/`), and `src/utils/debug.ts` has no `[apply-patch]`
  prefix.

### F5 — VERIFY: catch-all grammar means no constrained decoding

`src/utils/api.ts:74-78` ships `start: /(.|\n)*/` as the Lark grammar. If
upstream `openai/codex` ships the real V4A grammar for its freeform
apply_patch tool, adopting it would let the server constrain sampling to
well-formed patches — the single biggest remaining homefield lever against
residual format errors. Needs verification against upstream source
(`codex-rs`, apply-patch tool spec); note that changing the serialized tool
bytes is a one-time prompt-cache break for live conversations.

### F6 — LOW: nits

- `src/tools/FilePatchTool/prompt.ts:6` calls it a "shell command" (upstream
  phrasing); there is no Bash interception for `apply_patch` in this repo
  (verified by grep), so a literal shell attempt fails with command-not-found.
  Either reword to "tool" or intercept in BashTool.
- Marker-trim leniency (`parser.ts:119-134`) means a context/delete line whose
  content is literally `*** End Patch` (or another `*** ` marker) is treated
  as an envelope marker after trimming — files containing raw patch markers
  cannot be patched. Edge case; consistent with lenient-mode tradeoffs.
- An empty custom-tool input becomes `{}` (`src/utils/messages.ts:2702-2723`
  wraps only non-empty unparseable strings) and produces a confusing
  union-validation error for the model.

## Uncertainties

- Upstream Codex's actual freeform grammar definition (F5) — not verified
  offline; check `openai/codex` source. The local 2026-07-11 audit claims
  parity; my recollection disagrees.
- The "Update(patch)" header rendering (F3) is inferred from code, not
  verified in a live GPT session.
- The allow-rule-vs-cwd consequence in F1 depends on `matchWildcardPattern`
  semantics not traced here; the acceptEdits bypass is the proven part.

## Recommendation

Keep the tool — replacing Edit with Apply_patch for GPT models was the right
call and the implementation honors the training distribution where it counts.
Fix F1 promptly (real boundary hole in acceptEdits mode, which is in daily
use), then do the two cheap F4 measurement items before crediting the tool
with the advantage it was built for.
