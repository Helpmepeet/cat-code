# Upstream Divergence Map

Last refreshed: 2026-08-10

## Purpose

Cat Code is a fork of Claude Code frozen at upstream **2.1.87**. Upstream keeps
shipping. This map is the living record of where the two have diverged, which
divergences are deliberate, and how to check any specific behavior yourself.

It exists because the alternative is a dated report, and this repo treats dated
filenames as historical records rather than current truth. Findings age; the
*method* for re-deriving them does not. Use this map to answer three questions:

1. Is behavior X a Cat Code change or an upstream change since the fork?
2. Is a given divergence deliberate (leave it) or drift (consider adopting)?
3. How do I check something this map does not cover?

**Scope warning.** Only the prompt/instruction system has been audited end to
end (2026-08-10). Every other area is unexamined. Absence from the ledger below
means "not checked", never "no divergence".

## First Files To Inspect

| Order | File | Why first |
|---|---|---|
| 1 | [`../../package.json`](../../package.json) | `version` is pinned at the fork point (`2.1.87`) and has never moved. This is what makes a three-way comparison possible. |
| 2 | `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` | The **fork-point** upstream build, as readable JS. The SDK version tracks the CLI version, so `claude-agent-sdk@0.2.N` is CLI `2.1.N`. Confirm with the embedded `VERSION:"…"`. |
| 3 | `~/.local/share/claude/versions/<ver>` | **Current** upstream, a Bun-compiled binary. Confirm with `claude --version`. |
| 4 | [`2026-08-10-system-prompt-architecture-cat-vs-upstream.md`](../reports/2026-08-10-system-prompt-architecture-cat-vs-upstream.md) | The prompt-system audit this ledger summarizes. Read it before re-deriving prompt findings. |
| 5 | [`prompt-system.md`](prompt-system.md) | Cat Code's own prompt routing. This map is about *differences*; that one is about *ownership*. |

## How To Check A Divergence

Enumerate the supported interface before byte-slicing anything. `claude --help`
frequently exposes what you want as a flag or subcommand, and a documented flag
beats an inferred one.

When you do need the build's internals:

- Both upstream artifacts keep string literals intact; only identifiers are
  minified. Prompt text, tool descriptions, and CLI help are all greppable.
- The compiled binary stores strings in **two** tables, one UTF-8 and one
  UTF-16LE. `strings` and a plain `rg` see only the UTF-8 half and will make
  content look absent when it is present. Scan both encodings.
- Three-way is the point: fork-point bundle, current binary, current `src/`.
  Two-way cannot tell "Cat Code changed it" from "upstream changed it", and that
  distinction decides whether a difference is deliberate.

## Divergence Ledger — prompt system

Audited 2026-08-10. Detail and evidence in the linked report.

### Deliberate — do not re-sync toward upstream

| Divergence | Where | Why it is deliberate |
|---|---|---|
| Instruction files direct workflow but cannot authorize | [`../../src/utils/claudemd.ts`](../../src/utils/claudemd.ts), [`../../src/constants/corePolicy.ts`](../../src/constants/corePolicy.ts) | Upstream still says instructions "OVERRIDE any default behavior" unbounded and names `CLAUDE.md` as advance authorization for risky actions. Cat Code scopes the override and adds `INSTRUCTION_AUTHORITY_LIMIT`. Re-syncing reopens a repo-file injection path. |
| Section cache keyed by captured inputs | [`../../src/constants/systemPromptSections.ts`](../../src/constants/systemPromptSections.ts) | Upstream keys on the bare section name and disambiguates by interpolating discriminators into the name. Cat Code's structured encoder is load-bearing: provider is resolved per request from the model string, so a name-only key can serve Claude-worded text to a GPT model. |
| One policy core across providers and modes | [`../../src/constants/corePolicy.ts`](../../src/constants/corePolicy.ts) | Upstream has the equivalent text scattered per assembly with no shared module. Upstream's newer lean assembly then lost two invariants that way (see below). |
| Provider-split delivery | [`../../src/services/api/instructionAssembly.ts`](../../src/services/api/instructionAssembly.ts) | Upstream has one provider and no equivalent. |
| Second prompt style for GPT | [`../../src/constants/promptStyles/gpt.ts`](../../src/constants/promptStyles/gpt.ts) | No upstream counterpart. |

### Open — upstream moved, Cat Code has not

| Gap | Cat Code today | Judgment |
|---|---|---|
| Lean vs verbose default assembly, selected by model | one assembly only; no selector | **Undecided, and the largest open question.** Upstream routes its newest tier to a five-bullet harness prompt and pins the six-section prompt to Opus 4.x and below. The split extends to tool descriptions at 11 branch sites. Cat Code sends Opus 5 the verbose prompt and has been adding to it. |
| Stale-write guard on the section cache | absent | Adopt. Upstream added a generation counter so a section resolving after `/clear` cannot write stale text into the fresh cache. |
| Per-turn ToolSearch nudge | absent | Adopt. Cat Code ships deferred schemas and `ToolSearchTool` but never tells the model which schemas are unloaded. |
| `env_info` static/dynamic split | one mixed block | Adapt. Splitting moves roughly half the block into the cacheable prefix. |
| Cyber policy text | shortened paraphrase | Adopt upstream's fuller wording; the resolver already prefers the upstream constant if populated. |
| Shared-stash / worktree git rule | only in `CLAUDE.md` | Adopt into the prompt. It binds only agents that read `CLAUDE.md` today, and this tree is multi-session by default. |

### Cat Code additions with no upstream counterpart

`implementor` and `verification` agents
([`../../src/tools/AgentTool/built-in/verificationAgent.ts`](../../src/tools/AgentTool/built-in/verificationAgent.ts)),
map-first repository routing, Agent Mode and coordinator assemblies,
`session_transcripts` and `token_budget` prompt sections.

## Tests And Validation

There is no automated fork-drift check, and adding one is not obviously worth
it: upstream ships several times a week and most deltas do not matter. Validate
the Cat Code side instead, then reason about the delta by hand.

| Area | Command |
|---|---|
| Prompt policy core, sections, and cache keying | `bun test src/constants/corePolicy.test.ts src/constants/prompts.test.ts src/constants/systemPromptSections.test.ts` |
| Provider instruction placement | `bun test src/utils/providerPromptRegressions.test.ts` |
| Instruction-file framing | `bun test src/utils/claudemd.test.ts` |
| Docs battery for this map | `git diff --check && bun run maps:lint` |
| Full documented build | `bun run build:dev:full` |

To see what Cat Code actually emits, `/context` is currently the only live
surface. Both other inspection paths are dead by default — see the traps below.

## Traps And Stale Assumptions

- Do not assume a difference means Cat Code changed something. Roughly half the
  prompt-system differences found in the 2026-08-10 audit were upstream changes
  after the fork. Check the fork-point bundle before attributing.
- Do not assume `strings` or a plain `rg` over the upstream binary is complete.
  Half the literals are UTF-16LE. This makes present content look absent, which
  reads as "upstream removed it".
- Do not assume a section missing from the upstream registry was deleted. Of the
  four that left between 2.1.87 and 2.1.223, one relocated to the attachment
  channel, one was deleted, one lost only its announcement while the mechanism
  stayed, and one was internal-only.
- Do not assume a feature-gated string is live. Several upstream sections sit
  behind GrowthBook flags, and several Cat Code ones behind `feature()` build
  gates. A string in the source is not a string in the prompt.
- Do not port an upstream assembly wholesale. Upstream's lean prompt drops the
  prompt-injection and tool-output-is-data rules, because their only container
  is the verbose-only `# System` section. Cat Code already hit this class of bug
  in Agent Mode; [`../../src/constants/corePolicy.ts`](../../src/constants/corePolicy.ts) exists to prevent it.
- Do not reach for [`../../src/services/api/dumpPrompts.ts`](../../src/services/api/dumpPrompts.ts) to inspect an emitted
  prompt without setting `USER_TYPE=ant`. Every entry point returns early
  otherwise.
- Do not reach for `--dump-system-prompt` at all. The call site in
  [`../../src/entrypoints/cli.tsx`](../../src/entrypoints/cli.tsx) is guarded on a feature name absent from
  [`../../scripts/build.ts`](../../scripts/build.ts), so it is eliminated from every build and the CLI
  reports it as an unknown option.
- Do not treat this ledger as coverage. Only the prompt system has been audited.
  Codex/provider routing, permissions, compaction, tools, and the desktop app
  have not been compared at all.
