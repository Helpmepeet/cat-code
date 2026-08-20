# Codex CLI harness prompt: release-history measurement, and what it settles

**Date:** 2026-08-20
**Scope:** third-party comparator for Cat Code's GPT-targeted system prompt
**Status:** evidence artifact; one open decision closed, one left open
**Companions:** [`2026-08-10-system-prompt-architecture-cat-vs-upstream.md`](2026-08-10-system-prompt-architecture-cat-vs-upstream.md)
(the audit), [`2026-08-11-upstream-delivered-system-prompt-capture.md`](2026-08-11-upstream-delivered-system-prompt-capture.md)
(desktop capture), [`2026-08-12-upstream-baseline-no-mcp.md`](2026-08-12-upstream-baseline-no-mcp.md)
(terminal baseline).

## 1. Why this file exists

Cat Code emits two full system prompts: a Claude-targeted assembly
(`src/constants/prompts.ts`) and a separate GPT-targeted restatement
(`src/constants/promptStyles/gpt.ts`). The three companion docs measured both
against upstream Claude Code, but only the Claude-targeted side had a legitimate
comparator: upstream has no GPT path at all. The GPT-targeted prompt, at 18,100
chars, was being judged against a baseline that does not apply to it.

Codex CLI is the closest available native reference for how OpenAI prompts its
own coding agent, and unlike Claude Code it is source-available, so its prompt
can be measured across releases rather than transcribed at one point in time.
This file supplies that comparator.

### 1.1 Provenance, and what is not verified here

The Codex figures below were produced by a delegated session with no access to
this workspace, across two passes: an initial trend measurement and a follow-up
that recounted the load-bearing figures. Every number is cited by tag and, where
it matters, by Git blob SHA, so it is cheap to re-verify.

**They were not independently re-derived on this side.** Treat them as sourced
measurement with citable provenance, not as facts this repo has confirmed. The
Cat Code figures in §4 are the opposite: measured locally on 2026-08-19 with
`./cli-dev --dump-system-prompt`, reproducible with the commands in §4.1.

The delegation prompt carried an explicit gate against reconstructing Codex
prompt text from model memory rather than from source, because a confabulated
baseline would look identical to a successful capture and would silently poison
the decision it feeds. The returned work cites blobs throughout, which is the
evidence that gate held.

## 2. The trend

There is no single timeless Codex prompt file. The measured path:

| tag | sampled path | total chars |
|---|---|---|
| `rust-v0.1.0-alpha.3` | `codex-rs/core/prompt.md` | 5,698 |
| `rust-v0.20.0` | `codex-rs/core/prompt.md` | 23,430 |
| `rust-v0.40.0` | `gpt_5_codex_prompt.md` (default path) | 10,432 |
| `rust-v0.80.0` | `gpt-5.1-codex-max` base instructions | 11,693 |
| `rust-v0.148.0` | `models-manager/prompt.md` fallback | 20,751 |

By category:

| tag | behavioral | product | environment | intro | embedded tool spec |
|---|---|---|---|---|---|
| `alpha.3` | 3,056 | 284 | 236 | 33 | 2,089 |
| `v0.20.0` | 16,563 | 3,273 | 0 | 796 | 2,798 |
| `v0.40.0` | 5,733 | 4,594 | 0 | 105 | 0 |
| `v0.80.0` | 7,244 | 4,344 | 0 | 105 | 0 |
| `v0.148.0` | 17,571 | 2,383 | 0 | 797 | 0 |

Memory and scratchpad measured zero in every row. That is an artifact of
sampling the model-independent fallback: the priority-1 `gpt-5.6-sol` catalog
entry carries an inline override that does include compaction-continuity
guidance. Do not read the zero column as "Codex has no memory instructions".

**The shape is not monotonic.** Codex grew ~4x, cut the GPT-5-specific path by
more than half, then grew again. Two structural changes explain more than the
totals do:

- Model-specific prompt selection appears at `v0.40.0` and is fully established
  by `v0.148.0`, where each catalog model may override the base instructions.
  There is no configuration-independent "current Codex prompt size".
- Configuration-dependent material moved out of the static prompt into runtime
  developer fragments. §5 is about whether that saved anything.

The `v0.40.0` default-path selection was confirmed through source rather than by
constant name: `Config` falls through to `default_model()` → `OPENAI_DEFAULT_MODEL`
(`gpt-5-codex`) → `find_family_for_model()` maps the `gpt-5-codex` prefix to
`GPT_5_CODEX_INSTRUCTIONS` → `Prompt::get_full_instructions()` emits it into the
Responses `instructions` field. The ~24 KB generic prompt shipped alongside is
not what a default invocation received, so the -55% transition stands.

## 3. Delivered total for one named configuration

A configuration-independent total does not exist, so one concrete configuration
was measured instead — the same "one point, precisely known" method the two
upstream captures used.

Configuration: `rust-v0.148.0`, model `gpt-5.2` with no base-instructions
override, permission profile `:workspace`, approval policy `on-request`,
network restricted, one workspace root, bash, Unix. Tool schemas excluded.
Project instructions excluded.

| component | size |
|---|---|
| `gpt-5.2` model instructions (blob `8aa188f5e1c507291f329033a94c7a38b9f3c7b8`) | 21,652 bytes |
| rendered permissions fragment | 4,027 |
| rendered environment fragment | 729 |
| **total** | **26,408** |

This does not supersede the 20,751 fallback figure in §2; it answers a different
question. Note also that `gpt-5.2` is not the priority-1 model — `gpt-5.6-sol`
carries a larger override — so 26,408 is a floor for the current flagship path.

## 4. The comparison this was commissioned for

| | delivered, tool schemas excluded |
|---|---|
| upstream Claude Code, plain terminal | 11,188 |
| upstream Claude Code, desktop + MCP | 11,966 |
| **Cat Code, GPT style** | **18,100** |
| Cat Code, Claude style | 18,966 |
| **Codex `gpt-5.2` @ v0.148** | **26,408** |

Behavioral bucket only:

| | behavioral rules |
|---|---|
| upstream Claude Code (lean) | 6,832 |
| Cat Code, GPT style | 13,610 |
| Cat Code, Claude style | 15,341 |
| Codex v0.148 fallback | 17,571 |

**Cat Code's GPT-targeted prompt is 69% the size of Codex's delivered total in a
comparable configuration.** On the behavioral axis it is 78% of Codex's.

The premise the audit's Recommendation 0 was reasoning from — that 2.25x
upstream indicates bloat — rests on a single data point. Of the three coding
agents now measured, upstream Claude Code's lean path is the outlier; Codex and
Cat Code sit in the same band.

### 4.1 Reproducing the Cat Code side

```bash
cd /Users/pt/cat-code && ./cli-dev --dump-system-prompt --model claude-opus-5 --provider anthropic
```

```bash
cd /Users/pt/cat-code && ./cli-dev --dump-system-prompt --model gpt-5.6-sol --provider openai
```

`--model` does **not** select the style: `resolveRequestProvider` maps only
`gpt-*` prefixes, so a Claude model falls through to the persisted session
provider. `--provider` is what selects the assembly. Both dumps pass `tools: []`,
so tool-gated sections are absent and both figures are floors.

Section breakdown as measured 2026-08-19:

| block | Claude style | GPT style |
|---|---|---|
| Doing tasks | 5,173 | 4,617 |
| Executing actions with care | 3,363 | 2,788 |
| System / System Rules | 2,338 | 2,164 |
| Communicating with the user | 2,188 | 2,372 |
| Using your tools | 1,341 | 819 |
| Tone and style | 938 | 850 |
| Environment | 2,784 | 2,455 |
| Session-specific guidance | not emitted | 1,255 |
| Reading session transcripts | 1,309 | — |
| identity / preamble | 841 | — |

## 5. Extraction was relocation, not reduction

Between `v0.80.0` and `v0.148.0`, a 4,130-char `## Codex CLI harness, sandboxing,
and approvals` block left the model prompt. `PermissionsInstructions` now renders
only the active sandbox mode and approval policy as a `developer`-role fragment.

For the default interactive configuration that saved almost nothing:

**4,130 static chars → 4,027 active-policy chars, a 2.5% reduction.**

The saving is entirely a function of which policy is active, because the
`on-request` approval text alone is 3,661 chars:

| active policy | rendered permissions |
|---|---|
| read-only + never | 341 |
| danger-full-access + never | 365 |
| read-only + unless-trusted | 468 |
| workspace-write + never | 486 |
| danger-full-access + unless-trusted | 492 |
| workspace-write + unless-trusted | 613 |
| read-only + on-request | 3,882 |
| danger-full-access + on-request | 3,906 |
| workspace-write + on-request | 4,027 |

Range against the old 4,130: -91.7% to -2.5%. The list is the no-extras sweep
under a fixed environment; approved-prefix lists, granular approval text and
`request_permissions` can append more.

**The rule this actually supports** is narrower than "extract configuration-
dependent material": emit the expensive block only in configurations where it is
operative, and pay full price where it is. A block that is operative in the mode
the user is usually in yields no saving from being made conditional.

## 6. The retained text was not rewritten

The lineage file `codex-rs/core/gpt_5_codex_prompt.md` at both tags:

- `v0.80.0` blob `e2f9017874ab5a18b2f65a9f89a94d46f7c1999c`, 10,777 bytes
- `v0.148.0` blob `88a569fa723a999da32146ccfdc4ec8bfc8da37c`, 6,647 bytes

Excluding a 319-byte identity/`## General` prefix and the 4,130-byte sandbox
block, both resolve to a 6,328-byte behavioral region — 6,302 Unicode chars, the
13 non-ASCII code points accounting for the 26-byte difference. The two regions
are **byte-for-byte identical**: v0.148's file is v0.80's file with one block
removed and nothing else touched.

So when OpenAI shrank this prompt, they deleted a coherent block. They did not
tighten prose. Anthropic did the opposite — the lean assembly is new text, not a
subset. We now have one worked example of each method, and block removal is by
far the cheaper and lower-risk of the two.

## 7. What this settles, and what it does not

**Settled: the GPT-targeted prompt needs no cut.** It was the question this
comparator was commissioned to answer. At 69% of Codex's delivered total in a
comparable configuration, 18,100 chars is not out of line, and a lean cut
applied to `promptStyles/gpt.ts` would be a change made against no evidence.

**Not settled: the Claude-targeted prompt.** Recommendation 0 remains open and
this evidence does not touch it. Anthropic tuned its lean path on Claude models
with evals not visible here, and that is who the Claude assembly serves. Codex
evidence does not transfer across model families. The cheap A/B the audit
proposed is still what decides it.

**Consequence for how any cut is executed.** §5 and §6 together argue against
the *shape* of Recommendation 0 as written — a rewrite into a five-bullet
harness — and for gating or removing whole blocks instead. They also argue
against expecting much from conditionalizing a block that is usually operative.

**The two styles should now be expected to diverge in size**, because their
comparators diverge. A cut that lands on the Claude side and not the GPT side is
the correct outcome, not drift to be corrected.

## 8. Candidate cuts, re-scored against this evidence

An earlier pass proposed ~6k chars of extraction candidates on the strength of
the 4,130-char relocation. §5 invalidates most of that estimate:

| candidate | chars | verdict |
|---|---|---|
| `# Executing actions with care` | 3,363 | **Downgraded.** Cat Code's analogue to the extracted Codex block. Codex's own numbers put the saving at 2.5% in the configuration where the block is operative. Worth doing only if sessions commonly run in modes where it is not. |
| `# Using your tools` | 1,341 | **Survives on other grounds.** It unconditionally asserts a tool set ("do NOT use Bash when a dedicated tool is provided") that is wrong for any session with a restricted tool set. A correctness problem, not a size one. |
| `## Reading session transcripts` | 1,309 | **Survives fully.** Cat-only, unconditional, ships JSONL grep recipes every turn regardless of task. No policy caveat applies. |

Realistic unconditional-bloat lever: ~1.3k, not ~6k.

## 9. What this file does not establish

- **Anything about Codex's tool schemas.** Excluded from every figure on both
  sides. Codex's tool layer absorbed material that left the base prompt at
  `v0.40.0` (the 2,798-char embedded tool spec), so a tool-inclusive comparison
  could move the totals in either direction.
- **The `gpt-5.6-sol` override size.** Described but never measured, so the
  current flagship delivered total is unknown and 26,408 is a floor.
- **Whether relocation bought Codex anything other than size.** A static prefix
  that no longer varies with configuration is more cacheable, which may have
  been the point rather than byte count. Not investigated.
- **Any Cat Code mode distribution.** §8's first row cannot be scored without
  knowing how often sessions run in modes where the actions block is inoperative.
