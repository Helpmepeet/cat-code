# Cat Code versus upstream Claude Code: divergence ledger and method

**Date:** 2026-08-10
**Scope:** the fork relationship itself — where Cat Code and upstream have diverged, which divergences are deliberate, and how to establish either for a behavior this ledger does not cover
**Status:** reverse-engineering report; no implementation changes
**Source basis:** Cat Code working-tree source plus static analysis of two shipped upstream builds; source and executable control flow win over release notes and over dated docs

## 1. Executive conclusion

**Cat Code is pinned at upstream 2.1.87 and has diverged in both directions, so
"different from upstream" carries no default verdict.** Roughly half the
differences found in the one area audited so far are upstream changes made after
the fork, and the other half are deliberate Cat Code decisions, several of which
would be actively harmful to re-sync. Neither "upstream is newer, adopt it" nor
"ours is customized, keep it" survives contact with the evidence.

The practical consequence is that a two-way comparison is useless here. Reading
current Cat Code against current upstream cannot distinguish "Cat Code changed
it" from "upstream changed it", and that distinction is the entire question. A
three-way comparison against the fork-point build is what makes the ledger below
possible, and §2.2 records the artifact that supplies it.

The most important findings are:

1. **`package.json` `version` is the fork coordinate.** It has read `2.1.87`
   since the initial snapshot and has never moved. Everything in this report
   depends on that being a real fork point rather than a stale string, which
   §2.2 establishes independently from the shipped bundle.
2. **Deliberate divergences exist that look exactly like drift.** The
   instruction-authority wrapper and the input-keyed prompt-section cache both
   read as "Cat Code fell behind" and are the opposite. A session syncing them
   toward upstream would reopen a prompt-injection path and reintroduce a
   cache-correctness bug. This ledger exists primarily to prevent that.
3. **Upstream has made an architectural change Cat Code has not evaluated.**
   Upstream now selects between two entire default prompt assemblies on the
   model, and the split extends across tool descriptions. Cat Code has one
   assembly and no selector.
4. **Cat Code is ahead on invariant enforcement and behind on freshness.** It
   owns a policy core that forces safety invariants across assemblies; upstream
   does not, and lost two invariants on its new assembly as a result. Meanwhile
   Cat Code carries 2.1.87-era wording upstream has since revised.
5. **Neither prompt-inspection path in Cat Code works by default.** `/context`
   is the only live surface, which is why this report is built from source and
   static analysis rather than from emitted prompts.
6. **Coverage is one area deep, not broad.** Only the prompt and instruction
   system has been audited. Absence from this ledger means "not checked", never
   "no divergence".

## 2. Evidence standard and scope

### 2.1 Evidence labels

- **CAT-SOURCE:** confirmed by current Cat Code working-tree source.
- **UP187-STATIC:** confirmed by string or control flow in the shipped upstream
  2.1.87 bundle (the fork point).
- **UP223-STATIC:** confirmed by string or control flow in the shipped upstream
  2.1.223 executable.
- **RUNTIME:** verified by running a local, non-network command.
- **INFERENCE:** the strongest explanation supported by surrounding evidence,
  but not directly observable as a complete behavior.

A string was not treated as behavioral proof unless its producer, consumer, or
control-flow role was recovered. Where only a string was recovered, the claim is
labelled INFERENCE and says so.

### 2.2 Artifacts

Cat Code, under test:

```text
./cli-dev --version
2.1.87-dev.20260810.t153835.shae1e8a806 (Cat Code)
```

Fork-point upstream, as readable JavaScript:

- `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`
- SHA-256: `4dd5c9f5c9939975e1d866ca790359c8932e6a8b2dbb41a9b8ae3bcc7f13f8d0`
- Embedded `VERSION: "2.1.87"`, `BUILD_TIME: "2026-03-29T02:12:10Z"`
- 12.9 MB, identifiers minified, string literals and control flow intact

This artifact is what makes the fork coordinate independently checkable: the
Agent SDK's version tracks the CLI's, so `claude-agent-sdk@0.2.N` carries CLI
`2.1.N`, and the embedded `VERSION` constant agrees with `package.json`.

Current upstream:

```text
claude --version
2.1.223 (Claude Code)
```

- `/Users/pt/.local/share/claude/versions/2.1.223`
- SHA-256: `a63e3ecbf6b58812fb314b8a8d99a12b45ec7c11209ad09598469542edbba8b3`
- Mach-O arm64 Bun executable, build time `2026-08-05T18:12:31Z`, git SHA
  `4535f69721056abf01650c73ee8a91c69ba00838`

This hash matches the installed artifact recorded in
[`2026-08-09-claude-code-compaction-evolution.md`](2026-08-09-claude-code-compaction-evolution.md)
§2.2, which also establishes that the installed copy differs from the
upstream-original by 271 bytes confined to streamed thinking-delta handling.
That region is unrelated to prompt assembly, so findings here are unaffected.

### 2.3 Runtime boundary

No live model call was made. Every upstream claim is static; every Cat Code
claim is source-read or from a local non-network command.

One negative result was established at runtime rather than inferred:

```text
./cli-dev --dump-system-prompt --model claude-opus-5
error: unknown option '--dump-system-prompt'
```

Prompt-cache hit rates, GrowthBook flag values as served to a real account, and
any behavior that depends on the model's response are outside what this method
can establish. Several upstream sections in the ledger are flag-gated, and
whether they are live for a given user is explicitly unresolved.

## 3. Method: how to check a divergence

Enumerate the supported interface first. `claude --help` frequently exposes the
answer as a flag or subcommand, and a documented flag beats an inferred one.
This is worth repeating because the failure mode is expensive: a prior session
byte-sliced the 272 MB binary to recover auto-mode rules that
`claude auto-mode defaults` prints as JSON.

When the internals are genuinely needed:

- Both upstream artifacts keep string literals intact; only identifiers are
  minified. Prompt text, tool descriptions, and CLI help are all greppable.
- **The compiled binary stores strings in two tables, one UTF-8 and one
  UTF-16LE.** `strings` and a plain `rg` see only the UTF-8 half. This makes
  present content look absent, which reads as "upstream removed it" and produces
  confidently wrong findings. Scan both encodings.
- Recover the producer or consumer before believing a string. A section's text
  existing in the binary does not mean it is emitted: it may be behind a
  GrowthBook flag, a build-time feature gate, or a branch that is never taken.
- Compare three ways. Fork-point bundle, current binary, current `src/`.

## 4. Divergence ledger

Audited 2026-08-10. Full evidence and quoted control flow in
[`2026-08-10-system-prompt-architecture-cat-vs-upstream.md`](2026-08-10-system-prompt-architecture-cat-vs-upstream.md).

### 4.1 Deliberate — do not re-sync toward upstream

| Divergence | Owner | Evidence | Why deliberate |
|---|---|---|---|
| Instruction files direct workflow but cannot authorize actions | `src/utils/claudemd.ts`, `src/constants/corePolicy.ts` | CAT-SOURCE, UP187-STATIC, UP223-STATIC | Upstream's wrapper is byte-identical at 2.1.87 and 2.1.223 and claims unbounded override; its actions section names `CLAUDE.md` as advance authorization for risky actions. Cat Code scopes the override and adds `INSTRUCTION_AUTHORITY_LIMIT`. Re-syncing reopens injection via a hostile repo file. |
| Prompt-section cache keyed by captured inputs | `src/constants/systemPromptSections.ts` | CAT-SOURCE, UP223-STATIC | Upstream keys on the bare section name and disambiguates by interpolating discriminators into it. Cat Code's structured encoder is load-bearing: provider is resolved per request from the model string, so a name-only key can serve Claude-worded text to a GPT model. |
| One policy core across providers and modes | `src/constants/corePolicy.ts` | CAT-SOURCE, UP223-STATIC | `# Core policy` appears zero times upstream. Upstream's equivalent text is scattered per assembly, and its newer assembly lost two invariants that way. |
| Provider-split instruction delivery | `src/services/api/instructionAssembly.ts` | CAT-SOURCE | Upstream has one provider and no equivalent. |
| Second prompt style for GPT | `src/constants/promptStyles/gpt.ts` | CAT-SOURCE | No upstream counterpart. |

### 4.2 Open — upstream moved, Cat Code has not

| Gap | Evidence | Judgment |
|---|---|---|
| Lean vs verbose default assembly selected by model, extending to tool descriptions at 11 branch sites | UP223-STATIC (selector and both assemblies recovered), RUNTIME (this session's own prompt is the lean assembly) | **Undecided, and the largest open question.** Upstream pins the six-section prompt to Opus 4.x and below and routes its newest tier to a five-bullet harness block. Cat Code sends Opus 5 the verbose prompt and has been adding to it. |
| Stale-write guard on the section cache | UP223-STATIC, UP187-STATIC (absent at fork point), CAT-SOURCE (absent) | Adopt. A generation counter prevents a section resolving after `/clear` from writing stale text into the fresh cache. |
| Per-turn ToolSearch nudge (`tool_search_usage_reminder`) | UP223-STATIC, CAT-SOURCE (absent) | Adopt. Cat Code ships deferred schemas and `ToolSearchTool` but never names the unloaded ones. |
| `env_info` static/dynamic split | UP223-STATIC | Adapt the split, skip the flag. Moves roughly half the block into the cacheable prefix. |
| Cyber policy wording | UP223-STATIC | Adopt. Cat Code's baseline is a lossy paraphrase; the resolver already prefers the upstream constant if populated. |
| Shared-stash / worktree git rule | UP223-STATIC | Adopt into the prompt. Today it lives only in `CLAUDE.md`, so it binds only agents that read it, and this tree is multi-session by default. |

### 4.3 Cat Code additions with no upstream counterpart

`implementor` and `verification` agents, map-first repository routing, Agent
Mode and coordinator assemblies, and the `session_transcripts` and
`token_budget` prompt sections. **INFERENCE:** upstream's own additions since
the fork (`claude` catch-all agent, teammates, workflow subagents) point at
surfaces Cat Code does not have, so the two forks are specializing rather than
drifting apart on the same axis.

## 5. Defects this audit surfaced

1. **No stale-write guard in `resolveSystemPromptSections`** (CAT-SOURCE). Seven
   `clearSystemPromptSections()` call sites; async computes read files.
2. **`--dump-system-prompt` is dead** (RUNTIME, §2.3). The call site in
   `src/entrypoints/cli.tsx` guards on a feature name absent from
   `scripts/build.ts`.
3. **`dumpPrompts` is `USER_TYPE=ant` gated** (CAT-SOURCE) at every entry point,
   so the documented dump path produces nothing for this user.

Together (2) and (3) mean `/context` is the only live prompt-inspection surface.

## 6. Coverage

Audited: the prompt and instruction system, end to end, including assembly,
section caching, provider delivery, instruction-file loading, subagent prompts,
tool-description drift, and the per-turn attachment channel where it couples to
the system prompt.

Not audited: Codex and provider routing, permissions and auto-mode, compaction
(covered separately by the 2026-08-09 report), the tool implementations
themselves, the desktop app, accounts and OAuth, and everything under `app/`.

**This ledger is not a coverage claim.** An area's absence means no one has
looked.

## 7. Open uncertainties

- **Flag-gated upstream sections.** Several are behind GrowthBook flags
  (`tengu_verified_vs_assumed`, `tengu_silent_harbor`, `tengu_velvet_tide`,
  `SG()==="counter_steer"`). Call sites were recovered; served values were not.
  Resolvable only with a live request.
- **`Ym()` in the lean-assembly selector.** For `claude-opus-5` and
  `claude-fable-5` the predicate falls through to `return !Ym()`, which was not
  decoded. Lean is confirmed live for Opus 5 by RUNTIME evidence; the exact
  predicate for Fable 5 is INFERENCE.
- **Working-tree drift.** Four prompt files were dirty from a concurrent session
  during the audit. Findings describe the working tree, not HEAD.
