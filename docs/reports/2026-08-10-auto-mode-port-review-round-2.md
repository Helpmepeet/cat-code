# Auto-mode upstream port: second implementation review (RED)

Three-lane review (two code, one design-vs-plan) of the port at `37fe29d3`, run
2026-08-10 against `docs/plans/2026-08-09-auto-mode-design.md`. Follows
`2026-08-10-auto-mode-port-review.md`, whose nine findings had been reported
closed.

**Verdict: keep `AUTO_MODE_UPSTREAM_PORT` disabled.** Five High-severity
enablement blockers. Not production regressions, because the feature is still
compiled out of `fullExperimentalFeatures`. No files were changed.

Three findings are **second strikes** — previously reported closed, still open.

## High

### F1 — the GPT safety fallback runs at zero reasoning, not medium (second strike)

`getClassifierThinkingConfig` (`yoloClassifier.ts:828-838`) returns **both**
`thinking: false` and `reasoningEffort: 'medium'`. `sideQuery.ts:187-226` emits
them together. `codex-fetch-adapter.ts:1373-1398` gives disabled-thinking
precedence and maps it to the model's minimum. Executing the real translation
path yields `{"effort":"none"}`.

So the operator's decision — medium, because minimum is the wrong trade for a
safety fallback — is inverted in the shipped request. The plumbing looks correct
and is inert: `'medium'` is discarded before anything reads it.

### F2 — G2 failover is still wrong in ordering and auth-family crossing (second strike)

`autoModeProviderLadder.ts:14-46` prepends the configured GPT model to the whole
Sol → Terra → Luna chain. Probes give Terra → Sol → Luna → Bedrock Sonnet, and
Luna → Sol → Terra → first-party Sonnet. G2 requires *"continue at the next
**untried** member"*: Terra → Luna → Anthropic, and Luna → Anthropic.
`yoloClassifier.test.ts` currently asserts the wrong order.

Auth detection (`yoloClassifier.ts:1391-1405`) recognizes only status 401 and
named Codex errors. It misses the mid-request Codex pool error
(`codex-fetch-adapter.ts:3269-3279`, probe returned `fallback:false`), Bedrock
`CredentialsProviderError` and auth 403 (`withRetry.ts:1406-1418`), and Vertex
credential-load/refresh errors (`withRetry.ts:1433-1456`).

### F3 — the `$defaults` warning is invisible and mistimed

The only consumer sits inside prompt assembly (`yoloClassifier.ts:670-685`), so
it fires when a prompt is built, not when settings load. It uses
`logForDebugging()`, which `debug.ts:109-123` suppresses for non-ant users
unless debug mode is on. An operator who configures one `soft_deny` rule without
`$defaults` silently loses all 65 shipped soft-deny rules with no visible
warning.

### F4 — corpus verification accepts an empty or tampered manifest

`auto-mode-corpus.ts:57-68` casts arbitrary JSON to `Corpus` and iterates
`cases`. No validation of schema version, required fields, non-empty cases,
unique ids, or path suffixes. Generation writes a checksum (`:91-98`);
verification never reads it. A truncated corpus with `cases: []` verifies
successfully, so incomplete replay evidence can satisfy a future gate.

### F5 — closed delta 8 was never built

The design requires separately gated outcome-code, `gitStatus`, and
`repoVisibility` meta-injection (`design.md:320-323`). Request assembly
(`yoloClassifier.ts:972-1006`) carries CLAUDE.md, deny rules, transcript, and
action only. No meta flags or boundary tests exist. `logAutoModeOutcome` is
telemetry, not injection. This was not on the deferred list.

Consequence: unavailable results can still read as policy precedent, repeated
denials cannot collapse on outcome evidence, and repo state stays a guess — the
largest denial cluster in the census.

## Medium

- **F6** — terminal HTTP failures can become retryable via text matching
  (`yoloClassifier.ts:877-935`): a real 403 or 422 whose message contains
  "timeout" or "connection" crosses providers, though G2 classifies policy and
  validation failures as terminal.
- **F7 (second strike)** — G3's mandated live circumvention tests are absent.
  `autoModeDenyRules.test.ts:119-181` proves message construction and ordering
  only; nothing invokes `classifyYoloAction` to prove a denied Write survives a
  Bash redirection route, a denied Bash survives a scripting route, or the block
  survives malformed category data (`design.md:263-268`).
- **F8** — provider is attached to success and fallback events
  (`:1241-1248,1283-1293`) but omitted from parse failures (`:1137-1193`) and
  terminal errors (`:1323-1330`). G2 requires per-attempt telemetry.
- **F9** — `auto-mode-corpus.ts:15-28` does not reject unknown arguments, and
  only an exact `--verify` selects verification. `--verfiy` falls through to the
  writing branch (`:71-99`) and can overwrite the artifact and checksum.

## Low residuals

- Prior F8 partial: `autoMode.ts:184-191` describes `$defaults` splicing, then
  labels the same defaults "Defaults being replaced" (second strike).
- Prior L1: the ~110K prompt and the warning checks are rebuilt per classifier
  call (`:670-705`).
- Prior L2: `SOURCE.json` records neither the source binary digest nor a
  reproducible extraction command.

## Re-verification of the first review's nine

Closed: F1 (malformed/XML prompt), F3 (lossy corpus — for successful captures),
F5 (gate leakage), F7 (G1, except the excluded configured-category branch), F9
(invalid generation inputs).

Open or partial: **F2** (failover, second strike), **F4** (deny rules — runtime
closed, mandated tests absent, second strike), **F6** (GPT effort, second
strike), **F8** (critique label, partial second strike).

## Confirmed sound

Assembled prompt hash `910bae0f…`: forced `classify_result` contract, no XML
verdict instructions, no unmatched `<settings_deny_rules>`, no unresolved
substitution tags. `$defaults` position, once-only expansion, and list/text
parity correct. G1's discriminated schema and fail-closed two-layer parser
sound. G3 runtime flattening, first-seen dedup, JSON encoding, prefix ordering
sound. Global attempt counter and `sideQuery.maxRetries = 0` wired correctly. G4
forbidden settings absent. Flag absent from `scripts/build.ts:13-50`. All
vendored hashes match. Gate-off `cli-dev` excludes the upstream prompt.

## Executed verification

Feature gates return false under Bun. GPT translation probe: `{"effort":"none"}`.
Ladder probes confirmed backward Terra/Luna ordering. Prompt assembly probe
confirmed hash and structural invariants. Focused auto-mode suites 60 pass / 0
fail. `enableAutoModeFlag.test.ts` 14 pass / 4 fail, all four outside this range
(`f1f0518c` predates it). `git diff --check` clean.

Not executed: a feature-on build and `build:dev:full` restoration — the
review-only constraint blocked build-artifact writes, so gate-on reachability is
unverified this round. No live feature-on classifier request (would consume a
live account). Two CLI probes for F4/F9 were blocked by the same constraint; both
defects are confirmed from the implementation and its test coverage.
