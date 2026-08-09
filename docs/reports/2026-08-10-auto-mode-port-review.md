# Auto-mode upstream port: implementation review (RED)

Independent review of commits `776d638b..239ccc7e`, run 2026-08-10 against the
closed specification in `docs/plans/2026-08-09-auto-mode-design.md`.

Recorded verbatim in substance rather than summarized. Two of the findings below
exist because the implementer worked from their own reading instead of the
closed spec; re-paraphrasing the review here would repeat that mistake.

**Verdict: do not enable `AUTO_MODE_UPSTREAM_PORT`.** Substantial correct
mechanics, but four confirmed High-severity defects violate the closed design
and can invalidate classifier behaviour or replay evidence. The ported
classifier was never exercised live, so the defects are confirmed while their
production failure rates are unverified. The reviewer changed no files.

## Findings

| # | File:line | Finding | Severity |
|---|---|---|---|
| F1 | `upstream/system_prompt.txt:125`, `upstream/permissions.txt:123` | Runtime prompt contradicts the forced tool and contains an unclosed tag | High |
| F2 | `autoModeProviderLadder.ts:19`, `yoloClassifier.ts:1137` | Provider ordering, retry accounting, and pool failover violate G2 | High |
| F3 | `scripts/auto-mode-corpus.ts:49` | Frozen cases are not replay-equivalent classifier inputs | High |
| F4 | `autoModeDenyRules.ts:16` | Effective deny rules are filtered contrary to G3 | High |
| F5 | `yoloClassifier.ts:339`, `autoMode.ts:40` | Category and `$defaults` behaviour leak outside the feature gate | Medium |
| F6 | `yoloClassifier.ts:743` | GPT effort plumbing required by delta 3 is missing | Medium |
| F7 | `yoloClassifier.ts:329` | G1 remains only partially implemented | Medium |
| F8 | `autoMode.ts:54` | `auto-mode critique` remains tied to the legacy contract | Medium |
| F9 | `scripts/auto-mode-corpus.ts:59` | Corpus generation silently accepts missing/incomplete inputs | Medium |
| L1 | `yoloClassifier.ts:591` | The 110K prompt and warnings are rebuilt per classifier call | Low |
| L2 | `upstream/SOURCE.json:4` | Binary extraction cannot be independently reproduced from the manifest | Low |

Rejected by the reviewer: the four `enableAutoModeFlag.test.ts` failures
(predate the range, attributable to `f1f0518c`); the plan's declared-unfinished
items; the plan's wrong corpus commit hash (documentation, out of the reviewed
diff — but it is a real error: it reads `39c13c0b`, should be `239ccc7e`).

### F1 — the feature-on system prompt is internally malformed

Two independent defects:

1. Module 1's Output Format still instructs XML output, including
   `<block>yes</block>`, while the API forces a JSON tool call requiring
   `thinking`, `shouldBlock`, `reason`.
2. `permissions.txt` contributes a standalone `<settings_deny_rules>` opening
   tag that assembly never removes or closes. The real deny-rule block is
   supplied separately as a cached user message.

Assembly probe: `openDenyTags=1 closeDenyTags=0 xmlBlockInstruction=true
forcedToolFieldInstruction=true`.

Failure: the model follows XML semantics while the provider requires JSON tool
input, or reads the following ALLOW/environment sections as deny-rule contents.
Either produces parse failures and fail-closed denials.

Disposition: preserve the immutable upstream artifacts, but transform and
hash-test the runtime Output Format, and remove the unused deny-rule marker.

### F2 — G2 provider failover is not implemented as specified

- Configured Terra yields `Terra → Sol → Luna`; configured Luna yields
  `Luna → Sol → Terra`. G2 requires continuing only at the next untried standard
  chain member.
- The candidate list is truncated before provider-family skips. At
  `maxRetries: 1` the GPT ladder holds only Sol and Terra, so an auth failure
  skips both and never reaches Anthropic despite unused budget.
- `CodexAccountUnavailableError` ("No healthy Codex account is available for
  this request.") matches neither the auth branch nor the transient matcher, so
  it never crosses to Anthropic — preserving the outage class G2 exists to
  remove.
- Diagnostics retain model names only, not the attempted `(provider, model)`
  pairs G2 requires.

Evidence: `autoModeProviderLadder.ts:14-46`, `yoloClassifier.ts:785-846`,
`:1137-1162`, `:1259-1273`, `services/api/withRetry.ts:340-348`.

### F3 — the frozen corpus is not replay-equivalent

Stored per case: tool name, a locally reconstructed action, denial reason,
transcript basename. Not stored: the classifier transcript, prefix context,
effective configuration, full request, source path, or source digest — all of
which determine whether soft blocks clear.

The action projection also diverges from runtime: `Write` records only
`file_path` (runtime uses `file_path: content`), `Edit` likewise (runtime uses
`file_path: new_string`), and `Apply_patch` falls through to raw JSON truncated
at 300 chars. 38 `Write` and 35 `Apply_patch` cases are affected.

Failure: replay outcomes change because consent context or dangerous content was
omitted, not because the classifier improved or regressed.

Disposition: capture sanitized request dumps, or freeze enough exact request
components to reconstruct the same transcript, prefixes, projection, and
contract. Do not maintain a second hand-written tool projection.

### F4 — G3 discards effective deny rules

G3 requires flattening `ToolPermissionContext.alwaysDenyRules` in context order.
The implementation instead removes every `command`-source rule and every rule
whose content begins with `prompt:`. The tests codify the deviation.

The required cross-tool tests are also absent: denied `Write` via Bash, denied
Bash via a scripting tool, request ordering, malformed-category survival on the
live request path.

Failure: the permission system blocks a direct action, but the classifier is
never told the rule exists and approves the same effect through another tool.

### F5 — behaviour leaks outside the off-by-default gate

The forced tool schema always solicits `category`, and `auto-mode config` always
applies `$defaults` splicing, while the legacy runtime treats `$defaults` as
ordinary text and replaces the section. So the default-off CLI reports defaults
as retained when the active legacy classifier has replaced them.

### F6 — GPT effort plumbing is missing

`getClassifierThinkingConfig` returns `[false, 0]` for every normal model; no
GPT-family effort is resolved or supplied. A direct omission of delta 3, not a
declared-unfinished item.

### F7 — G1 remains partial

The fail-closed two-layer parser is correct: a malformed category cannot clear a
block. Still unimplemented: the `shouldBlock`-discriminated `oneOf` schema;
`{kind: "built_in", id}` representation; rejecting categories on allow verdicts;
the required bounded log when a category is dropped. Excludes the deliberately
unfinished `{kind: "configured", …}` branch.

### F8 — `auto-mode critique` is stale

Describes three categories, ignores `hard_deny` when deciding whether custom
rules exist, omits it from the summary, assembles the legacy prompt via
`buildDefaultExternalSystemPrompt`, and states that every custom section
replaces defaults. A hard-deny-only config reports as having no custom rules.

### F9 — corpus generation silently accepts bad input

`walk()` turns a missing or unreadable root into an empty traversal; per-file
failures are skipped silently; `MAX_ALLOW` is unvalidated. The script then
writes and hashes whatever remains. A mistyped `--root` replaces the corpus and
checksum with a reproducible but empty artifact.

## Confirmed positives

`AUTO_MODE_UPSTREAM_PORT` absent from `scripts/build.ts`; gate-off binaries
exclude the upstream prompt and gate-on include it; vendored inventory is
17/65/1/20; all 103 rule strings occur in `permissions.txt`; `rules.json` is
byte-identical to both `claude auto-mode defaults` and `auto-mode config` on
2.1.223; all recorded vendored hashes match; `$defaults` position and once-only
expansion are correct; core verdict parsing fails closed independently of
category parsing; forbidden two-stage/severity settings were not added; the dump
is opt-in and no longer user-type gated; corpus metadata matches 428 blocks, 289
allows, 22 tools, 717 cases.

## Conformance summary

Matches: `$defaults` splice helper · hard/soft tier inventory · G4 forbidden
settings absence · ungated opt-in dump · frozen artifact, counts and checksum ·
main feature absent from `fullExperimentalFeatures`.

Partial: model setting and primary provider override · G1 verdict contract ·
complete off-by-default atomicity.

Diverges: provider ladder and global retry budget · runtime prompt contract and
assembly · G2 failover · G3 deny-rule seam · replay-equivalent corpus inputs.

Missing: GPT effort plumbing.

## Reviewer's verification

Feature gate returns false under `bun test`. Focused suites 58 pass / 4 fail,
all four predating the range. `build:dev:full` green. Gate-on build contained the
upstream prompt marker; restored gate-off build did not. `claude --version`
2.1.223; `auto-mode defaults` and `auto-mode config` both hash to `15063b07…`,
matching `rules.json`. Corpus checksum verifies. `git diff --check` clean.

Not run: any live ported-classifier call or replay; nine-version extraction
reproduction; a clean endpoint checkout (a permission hook blocked creating a
disposable clone outside authorized workspaces, so the build ran against the
combined tree with the reviewed files confirmed identical to `239ccc7e`).
