# Phase 0 Prompt Pack

This file stores the investigation prompts for the 8 independent Phase 0 tasks, plus the final coordination prompt to reconcile overlaps and conflicts across the reports.

Use these prompts after reading `docs/vision/2026-04-30-GOAL_PLAN.md` and `docs/reports/2026-04-30-research-provider-differences.md`.

## What Phase 0 is actually building

The end goal of Phase 0 is to make the codebase **provider-aware**: wherever behavior must differ between Claude (Anthropic) and GPT (OpenAI/Codex), the code should apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. The implementation mechanism (dispatch function, config object, polymorphism, switch, strategy pattern — whatever fits the code) is secondary. What matters is that each provider ends up receiving the right instructions, format, protocol, and schema for that provider specifically.

Each investigation task below targets one specific layer where that provider-awareness is needed. Your job is to find where the current code is provider-blind, explain what the correct per-provider behavior is, and propose where and how the dispatch should happen.

When reading each prompt, keep this framing in mind:
- **Today**: the code does one thing, shaped around Claude.
- **After Phase 0**: the code knows which provider it is talking to and applies the correct behavior for that provider.
- **Your job**: identify what "correct behavior" means per provider for this specific layer, and design where and how the dispatch lives.

---

## 1) Role-native instruction hierarchy

```text
End goal: The codebase must apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. This task investigates one specific layer where that provider-awareness is needed: instruction assembly.

Investigate the workspace for provider-specific instruction assembly, with focus on making GPT use a role-native hierarchy instead of inheriting Claude-shaped prompt assembly.

Implementation goal:
The codebase currently assembles system/developer/user instructions in a Claude-shaped way (top-level `system` parameter). The end goal is for the code to know which provider it is targeting and apply the correct instruction assembly for that provider: Claude uses the top-level `system` parameter with no `system` role in `messages[]`; GPT uses role-stacked developer/user/system roles or an `instructions` parameter. The dispatch mechanism can take any form that fits the existing code — what matters is that each provider gets native request assembly, not a shared format that one provider misreads.

Required context:
- Read `docs/reports/2026-04-30-research-provider-differences.md` first and use it as design context, especially the sections on instruction hierarchy, request assembly, prompt caching, and orchestration.
- Read `docs/vision/2026-04-30-GOAL_PLAN.md` and find the Phase 0 entry for **Role-native instruction hierarchy**.

Your task:
1. Identify the prompt/instruction assembly surfaces that determine how system/developer/user behavior is constructed today.
2. Find where Claude-first instruction assumptions currently leak into the GPT/OpenAI path.
3. Explain the current architecture for shared vs provider-specific instruction content.
4. Propose a design plan for introducing role-native instruction hierarchy:
   - what should stay shared
   - what should split by provider and what each provider's version looks like
   - where in the codebase the provider dispatch should live
   - what concrete shape the dispatch should take (which function, which config object, how the two provider paths differ)
   - what not to change yet
5. Identify risks, migration traps, and verification strategy.

Deliverables:
- Create a report file at `docs/prompts/2026-04-30-role-native-instruction-hierarchy.md`
- The report should include:
  - summary
  - relevant files
  - current behavior
  - design recommendation (including the specific dispatch location and what each provider path does)
  - risks
  - suggested next implementation slice
- Update the matching Phase 0 entry in `docs/vision/2026-04-30-GOAL_PLAN.md` so it references `docs/prompts/2026-04-30-role-native-instruction-hierarchy.md`

Important:
- Do not implement code changes beyond writing the report and updating docs/vision/2026-04-30-GOAL_PLAN.md.
- Keep the plan grounded in the current workspace, not generic advice.
- The dispatch mechanism is not prescribed — use whatever fits the code. What matters is that each provider gets the right behavior.
```

---

## 2) Reduce XML to structure-only use

```text
End goal: The codebase must apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. This task investigates one specific layer where that provider-awareness is needed: XML and prompt control surfaces.

Investigate how XML-like wrappers are used across the workspace and design a plan to reduce them to structure-only use, especially on the GPT path.

Implementation goal:
The codebase may use XML-like tags (e.g. <thinking>, <task>, <context>) as a behavioral control surface that works well for Claude but is meaningless or counter-productive for GPT. The end goal is that XML is only used where it genuinely helps parsing, and wherever XML is acting as an implicit control mechanism, the code applies the correct format for the active provider — XML on the Claude path, plain structure or JSON on the GPT path. The implementation mechanism is not prescribed; what matters is that GPT does not receive XML-based control instructions that it will ignore or misread.

Required context:
- Read `docs/reports/2026-04-30-research-provider-differences.md` first and use it as design context, especially the sections on XML wrappers, instruction hierarchy, and structured outputs.
- Read `docs/vision/2026-04-30-GOAL_PLAN.md` and find the Phase 0 entry for **Reduce XML to structure-only use**.

Your task:
1. Find prompt surfaces, templates, constants, and instruction builders that use XML-like wrappers or XML-oriented framing.
2. Distinguish between:
   - XML used for readability/structure (safe to keep shared)
   - XML used as an implicit control mechanism (needs provider-specific behavior)
   - XML that may now be unnecessary on either path (can be removed)
3. Identify where XML is likely safe to keep and where it should be trimmed or replaced on GPT paths.
4. Propose a design plan for reducing XML dependence without causing broad regressions:
   - which XML uses need provider-specific behavior and what each provider's version looks like
   - which XML uses can be removed entirely
   - where in the codebase the provider dispatch should live
5. Suggest a staged investigation/implementation order and how to verify behavior after changes.

Deliverables:
- Create a report file at `docs/prompts/2026-04-30-reduce-xml-to-structure-only.md`
- The report should include:
  - summary
  - relevant files
  - current XML usage categories
  - design recommendation (including specific dispatch locations and what each provider path does)
  - risks
  - suggested next implementation slice
- Update the matching Phase 0 entry in `docs/vision/2026-04-30-GOAL_PLAN.md` so it references `docs/prompts/2026-04-30-reduce-xml-to-structure-only.md`

Important:
- Do not implement code changes beyond writing the report and updating docs/vision/2026-04-30-GOAL_PLAN.md.
- Be specific about repo surfaces.
- The dispatch mechanism is not prescribed — use whatever fits the code.
```

---

## 3) Remove visible-thinking dependence

```text
End goal: The codebase must apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. This task investigates one specific layer where that provider-awareness is needed: visible thinking and reasoning continuity.

Investigate whether this workspace depends on visible thinking text (for example <thinking>-style content or reasoning-like prompt conventions) as part of model state or behavior, and design a provider-aware removal plan.

Implementation goal:
Claude can produce visible thinking (extended thinking blocks) that the system may currently replay as state. GPT's reasoning is internal and discarded — it cannot be replayed. The end goal is to remove any code that assumes visible thinking is state, and where reasoning continuity is genuinely needed, to apply the correct continuity mechanism per provider: Claude preserves thinking blocks for tool continuity; GPT uses reasoning summaries or encrypted reasoning items. The dispatch mechanism is not prescribed; what matters is that neither provider path tries to use a continuity mechanism the provider does not support.

Required context:
- Read `docs/reports/2026-04-30-research-provider-differences.md` first and use it as design context, especially the sections on thinking/reasoning, tool continuity, long-running context, and orchestration.
- Read `docs/vision/2026-04-30-GOAL_PLAN.md` and find the Phase 0 entry for **Remove visible-thinking dependence**.

Your task:
1. Search the workspace for explicit thinking/reasoning wrappers, prompt instructions, message conventions, replay logic, compaction assumptions, or state handling that depend on visible thought content.
2. Separate:
   - user-facing reasoning guidance
   - internal prompt rules about thinking
   - actual state continuity assumptions
3. Explain where visible-thinking dependence exists today, if anywhere.
4. Propose a design plan for removing that dependence while preserving useful behavior:
   - what can be deleted entirely
   - what needs provider-specific behavior (and what each provider's version looks like)
   - where the dispatch should live
5. Identify what can remain shared across providers and what must differ.
6. Suggest how to verify that the system no longer depends on visible thinking as state.

Deliverables:
- Create a report file at `docs/prompts/2026-04-30-remove-visible-thinking-dependence.md`
- The report should include:
  - summary
  - relevant files
  - current dependence findings
  - design recommendation (including specific dispatch locations and what each provider path does)
  - risks
  - suggested next implementation slice
- Update the matching Phase 0 entry in `docs/vision/2026-04-30-GOAL_PLAN.md` so it references `docs/prompts/2026-04-30-remove-visible-thinking-dependence.md`

Important:
- Do not implement code changes beyond writing the report and updating docs/vision/2026-04-30-GOAL_PLAN.md.
- If there is little or no real dependence, say that clearly.
- The dispatch mechanism is not prescribed — use whatever fits the code.
```

---

## 4) Prefix-friendly prompt assembly

```text
End goal: The codebase must apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. This task investigates one specific layer where that provider-awareness is needed: prompt assembly and caching.

Investigate how prompts and request payloads are assembled in this workspace, and design a plan to make prompt assembly prefix-friendly for provider-native caching and stable control surfaces.

Implementation goal:
Claude and GPT have different caching models (explicit breakpoints/TTL vs automatic prefix hash). The end goal is prompt assembly that is prefix-stable for both — with provider-specific caching knobs applied correctly for the active provider. Claude uses explicit cache_control breakpoints; GPT uses prompt_cache_key and prefix discipline. The assembly order of stable vs dynamic content should be correct on each provider's path. The dispatch mechanism is not prescribed; what matters is that each provider's caching model is used correctly, not ignored or misapplied.

Required context:
- Read `docs/reports/2026-04-30-research-provider-differences.md` first and use it as design context, especially the sections on prompt caching, instruction hierarchy, request assembly, and tool search/caching interactions.
- Read `docs/vision/2026-04-30-GOAL_PLAN.md` and find the Phase 0 entry for **Prefix-friendly prompt assembly**.

Your task:
1. Find where prompt text, tool descriptions, environment details, policy text, and dynamic session/task content are combined today.
2. Explain the current assembly order and what parts are stable versus dynamic.
3. Identify places where frequent churn in early prompt segments may hurt provider-native caching or make behavior harder to reason about.
4. Propose a design plan for prefix-friendly prompt assembly:
   - what belongs in the stable prefix (shared across providers)
   - what belongs in the dynamic tail
   - where provider-specific caching knobs should be set and what each provider's version looks like
   - how provider-specific content should fit into that structure
5. Call out anything that should explicitly be ignored for this task.

Deliverables:
- Create a report file at `docs/prompts/2026-04-30-prefix-friendly-prompt-assembly.md`
- The report should include:
  - summary
  - relevant files
  - current assembly map
  - design recommendation (including specific dispatch locations and what each provider's caching path looks like)
  - risks
  - suggested next implementation slice
- Update the matching Phase 0 entry in `docs/vision/2026-04-30-GOAL_PLAN.md` so it references `docs/prompts/2026-04-30-prefix-friendly-prompt-assembly.md`

Important:
- Do not implement code changes beyond writing the report and updating docs/vision/2026-04-30-GOAL_PLAN.md.
- The dispatch mechanism is not prescribed — use whatever fits the code.
```

---

## 5) Structured handoff contracts

```text
End goal: The codebase must apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. This task investigates one specific layer where that provider-awareness is needed: agent and component handoffs.

Investigate handoff points in the workspace where one component, agent, or stage passes work to another, and design a plan for replacing freeform handoffs with structured contracts where reliability matters.

Implementation goal:
Handoffs that work as freeform prose with Claude may fail on GPT because GPT parses instructions more literally. The end goal is that high-value handoffs use a structured contract format, with provider-specific contract shapes where the format must differ between Claude and GPT. The dispatch mechanism is not prescribed; what matters is that each provider receives handoffs in a format it can reliably parse and act on.

Required context:
- Read `docs/reports/2026-04-30-research-provider-differences.md` first and use it as design context, especially the sections on coordinator/worker handoffs, structured outputs, orchestration, and safety.
- Read `docs/vision/2026-04-30-GOAL_PLAN.md` and find the Phase 0 entry for **Structured handoff contracts**.

Your task:
1. Find the places in the workspace where task packets, sub-agent requests, tool-oriented plans, or multi-stage instructions are handed off between components.
2. Describe which handoffs are currently freeform versus structured.
3. Identify the highest-value handoff surfaces for structured contracts.
4. Propose a design plan:
   - which handoffs should become structured first
   - what fields/contracts they likely need
   - whether the contract format must differ by provider and what each provider's version looks like
   - what should remain freeform
5. Identify risks, especially around over-structuring low-value paths.
6. Suggest a minimal first implementation slice and how to verify it.

Deliverables:
- Create a report file at `docs/prompts/structured_handoff_contracts.md`
- The report should include:
  - summary
  - relevant files
  - current handoff map
  - design recommendation (including specific dispatch locations where provider differences require it)
  - risks
  - suggested next implementation slice
- Update the matching Phase 0 entry in `docs/vision/2026-04-30-GOAL_PLAN.md` so it references `docs/prompts/structured_handoff_contracts.md`

Important:
- Do not implement code changes beyond writing the report and updating docs/vision/2026-04-30-GOAL_PLAN.md.
- Keep the design practical for this repo.
- The dispatch mechanism is not prescribed — use whatever fits the code.
```

---

## 6) Strict structured outputs

```text
End goal: The codebase must apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. This task investigates one specific layer where that provider-awareness is needed: structured output schemas.

Investigate where this workspace relies on machine-readable model outputs and design a plan for introducing strict structured outputs with provider-aware constraints.

Implementation goal:
Claude and GPT have different structured output constraints and schema limits. Using a single schema definition will produce 400 errors on one provider or the other. The end goal is a provider-aware schema layer where each provider gets a schema that fits its actual constraints: Claude's complexity budget, citation incompatibility; GPT's nesting depth limits, property caps, enum size limits. The dispatch mechanism is not prescribed; what matters is that each provider receives a schema it can actually enforce, not a shared schema that silently fails on one path.

Required context:
- Read `docs/reports/2026-04-30-research-provider-differences.md` first and use it as design context, especially the sections on structured JSON outputs, strict schema tool calling, and provider-specific schema limits.
- Read `docs/vision/2026-04-30-GOAL_PLAN.md` and find the Phase 0 entry for **Strict structured outputs**.

Your task:
1. Find places where the model is expected to return machine-readable content, structured data, or tightly formatted outputs.
2. Distinguish between:
   - outputs that truly need strict schemas
   - outputs that can remain natural language
3. Identify current fragility in these output expectations.
4. Propose a design plan for strict structured outputs:
   - best candidate surfaces
   - what a provider-aware schema layer looks like and where it lives
   - what each provider's schema constraints are and how they differ
   - what shared abstraction is appropriate
   - what should be left alone
5. Suggest verification and failure-handling strategy.

Deliverables:
- Create a report file at `docs/prompts/strict_structured_outputs.md`
- The report should include:
  - summary
  - relevant files
  - current structured-output surfaces
  - design recommendation (including specific dispatch locations and what each provider's schema path looks like)
  - risks
  - suggested next implementation slice
- Update the matching Phase 0 entry in `docs/vision/2026-04-30-GOAL_PLAN.md` so it references `docs/prompts/strict_structured_outputs.md`

Important:
- Do not implement code changes beyond writing the report and updating docs/vision/2026-04-30-GOAL_PLAN.md.
- The dispatch mechanism is not prescribed — use whatever fits the code.
```

---

## 7) Schema-first tool contracts

```text
End goal: The codebase must apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. This task investigates one specific layer where that provider-awareness is needed: tool definitions and contracts.

Investigate how tools are currently described and invoked in this workspace, and design a plan to move toward schema-first tool contracts with provider-aware constraints.

Implementation goal:
Claude and GPT have different tool-calling protocols and schema enforcement rules. The end goal is that tool contracts are schema-first and the codebase applies the correct tool format and schema constraints for the active provider: Claude uses `tool_use` blocks with Claude schema limits; GPT uses `function_call` / `call_id` protocol with GPT schema normalization. The dispatch mechanism is not prescribed; what matters is that each provider receives tool definitions in the format and schema shape it actually supports.

Required context:
- Read `docs/reports/2026-04-30-research-provider-differences.md` first and use it as design context, especially the sections on client tool loops, strict schema tool calling, structured outputs, and coding assistant primitives.
- Read `docs/vision/2026-04-30-GOAL_PLAN.md` and find the Phase 0 entry for **Schema-first tool contracts**.

Your task:
1. Find the tool definitions, tool registries, tool descriptions, and any tool-related prompt surfaces in the workspace.
2. Explain how tool contracts are represented today:
   - schema-first
   - prose-first
   - mixed
3. Identify where current tool descriptions rely too much on natural-language interpretation.
4. Propose a design plan for schema-first tool contracts:
   - where to start
   - what abstraction boundaries make sense
   - how provider-specific constraints should be handled and what each provider's path looks like
   - what not to change yet
5. Suggest how to verify the new contracts without requiring a full runtime migration.

Deliverables:
- Create a report file at `docs/prompts/2026-04-30-schema-first-tool-contracts.md`
- The report should include:
  - summary
  - relevant files
  - current tool-contract findings
  - design recommendation (including specific dispatch locations and what each provider's tool path looks like)
  - risks
  - suggested next implementation slice
- Update the matching Phase 0 entry in `docs/vision/2026-04-30-GOAL_PLAN.md` so it references `docs/prompts/2026-04-30-schema-first-tool-contracts.md`

Important:
- Do not implement code changes beyond writing the report and updating docs/vision/2026-04-30-GOAL_PLAN.md.
- The dispatch mechanism is not prescribed — use whatever fits the code.
```

---

## 8) GPT-native call-ID tool state

```text
End goal: The codebase must apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. This task investigates one specific layer where that provider-awareness is needed: the tool execution loop and state tracking.

Investigate the current tool-state/orchestration flow in this workspace and design a plan for adopting GPT-native call-ID-based tool state instead of Claude-style tool-result assumptions on the OpenAI path.

Implementation goal:
This is the highest-risk task because the tool loop is the execution core. Currently the tool loop is Claude-shaped: `tool_use` blocks → run tool → reply with `tool_result` blocks. GPT requires a completely different format: `function_call` output items → run tool → reply with `function_call_output` items keyed by `call_id`. The end goal is that the code knows which provider it is using and applies the correct tool loop protocol for that provider. This must be a real provider-aware design — not an adapter shim that makes one format look like the other — because getting it wrong breaks tool continuity entirely.

Required context:
- Read `docs/reports/2026-04-30-research-provider-differences.md` first and use it as design context, especially the sections on client tool loop, parallel tool calls, thinking/reasoning continuity, and agent orchestration.
- Read `docs/vision/2026-04-30-GOAL_PLAN.md` and find the Phase 0 entry for **GPT-native call-ID tool state**.

Your task:
1. Find the current tool loop/orchestration/message-state surfaces in the workspace.
2. Explain how tool continuity is tracked today, especially where Claude-first assumptions shape the flow.
3. Identify what would need to change for GPT-native call-ID-based tool state:
   - exactly what the Claude path of the tool loop does today
   - exactly what the GPT path needs to do instead
4. Propose a design plan:
   - where in the codebase the provider-aware dispatch should live
   - what the minimal architectural changes are to make the dispatch clean (not shimmed)
   - what can remain shared above and below the dispatch point
   - what must explicitly be deferred
5. Identify migration risk, testing needs, and rollback considerations.

Deliverables:
- Create a report file at `docs/prompts/gpt_native_call_id_tool_state.md`
- The report should include:
  - summary
  - relevant files
  - current orchestration findings
  - design recommendation (including the specific dispatch location and what each provider's tool loop looks like)
  - risks
  - suggested next implementation slice
- Update the matching Phase 0 entry in `docs/vision/2026-04-30-GOAL_PLAN.md` so it references `docs/prompts/gpt_native_call_id_tool_state.md`

Important:
- Do not implement code changes beyond writing the report and updating docs/vision/2026-04-30-GOAL_PLAN.md.
- This is the highest-risk Phase 0 task; keep the design concrete and repo-specific.
- Do not propose adapter shims. The dispatch must be real.
```

---

## 9) Final coordination and conflict resolution pass

```text
End goal: The codebase must apply the correct behavior for the active provider — not Claude-shaped defaults that silently break on GPT. Phase 0 produced 8 investigation reports, each covering one layer where that provider-awareness is needed. Your job now is to make sure those 8 plans can be implemented together without conflict.

All 8 Phase 0 investigation reports are now complete. Your job is to act as the orchestration and conflict-resolution pass across them.

Context on what Phase 0 is building:
Phase 0 is about making the codebase provider-aware. Each of the 8 tasks targets a specific layer where behavior must differ between Claude and GPT, and each report should have proposed a concrete dispatch design — a specific file, location, and what each provider's behavior looks like there. The coordination pass must reason about these dispatch points as a system: do they share a common provider-detection mechanism? Do they conflict in their assumptions about shared code? Do they touch the same files in incompatible ways? The goal is 8 clean, independent, implementable provider-aware behaviors — not a unified mega-migration.

Required context:
- Read `docs/vision/2026-04-30-GOAL_PLAN.md`
- Read `docs/reports/2026-04-30-research-provider-differences.md`
- Read every report in `docs/prompts/`, especially these 8:
  - `docs/prompts/2026-04-30-role-native-instruction-hierarchy.md`
  - `docs/prompts/2026-04-30-reduce-xml-to-structure-only.md`
  - `docs/prompts/2026-04-30-remove-visible-thinking-dependence.md`
  - `docs/prompts/2026-04-30-prefix-friendly-prompt-assembly.md`
  - `docs/prompts/structured_handoff_contracts.md`
  - `docs/prompts/strict_structured_outputs.md`
  - `docs/prompts/2026-04-30-schema-first-tool-contracts.md`
  - `docs/prompts/gpt_native_call_id_tool_state.md`

Goal:
These 8 tasks were investigated independently and should remain independent implementation tracks. However, they may conflict, overlap, or make incompatible assumptions about shared files, abstractions, prompt surfaces, or orchestration layers. In particular:
- Multiple tasks may need the same provider-detection mechanism — these should be unified, not duplicated.
- Multiple tasks may propose changes to the same shared file — these need sequencing or boundary rules.
- One task's design may assume a code structure that another task removes.

Your job is to resolve those conflicts at the report/design level, not by implementing code and not by collapsing the 8 tasks into one giant task.

Core rules:
- Preserve the 8 tasks as separate tracks.
- Do not merge them into one master implementation plan.
- You MAY edit the report files in `docs/prompts/` to remove contradictions, clarify boundaries, add dependency notes, add hotspot warnings, or narrow scope.
- If two reports conflict, resolve the conflict by updating the reports so they can coexist safely.
- Prefer minimal edits that preserve each report's core purpose.
- If a real dependency exists (especially around provider detection, shared abstractions, or shared files), make it explicit in the affected reports rather than pretending the tasks are fully independent.
- Do not substantially rewrite a report unless that is necessary to resolve a real conflict.

Your task:
1. Read and understand all 8 reports as related but separate plans.
2. Build a cross-report map of:
   - shared files
   - shared abstractions
   - shared prompt surfaces
   - shared orchestration/runtime surfaces
   - proposed dispatch points that require the same or conflicting provider-detection mechanism
3. Identify conflicts such as:
   - incompatible abstractions
   - overlapping ownership of the same layer
   - sequencing contradictions
   - one report assuming a structure that another report removes
   - duplicated refactor effort
   - two reports proposing different locations for provider detection
4. Resolve those conflicts by editing the report files where needed:
   - add dependency notes
   - narrow or clarify scope
   - assign boundaries between reports
   - mark hotspots
   - add "do not combine with" or "coordinate with" notes
   - revise recommended implementation order inside reports when needed
   - if multiple reports need the same provider-detection point, designate one as the owner and add cross-references in the others
5. Produce a coordination report that explains:
   - what conflicts were found
   - what was changed in which report
   - what remains independent
   - what must be coordinated (especially shared provider-detection and shared file ownership)
   - recommended execution order
   - safe parallelization opportunities
6. Update `docs/vision/2026-04-30-GOAL_PLAN.md` only if useful to improve coordination clarity:
   - add one coordination reference to the final coordination report
   - add short dependency/hotspot notes if needed
   - keep the 8 tasks separate

Deliverables:
1. Edit the existing report files in `docs/prompts/` as needed to resolve conflicts.
2. Create a final coordination report at:
   - `docs/prompts/phase0_coordination_report.md`

3. The coordination report must include:
   - Executive summary
   - The shared provider-detection mechanism: which report owns it, what it looks like, where in the codebase it belongs
   - Independence boundaries by task
   - Shared hotspots
   - Conflicts found
   - Report changes made to resolve conflicts
   - Cross-task dependencies
   - Recommended execution order
   - Safe parallelization opportunities
   - Conflict-management rules during implementation
   - Recommended minimal GOAL_PLAN updates

Important:
- Do not implement the actual code changes.
- Do not replace the 8 tasks with one umbrella migration.
- Do not erase important differences in scope/risk just to make the reports look consistent.
- Resolve conflicts by clarifying and editing report-level plans, not by inventing a giant unified redesign.
- Be concrete and repo-specific.
- Prefer preserving independence unless coordination is truly necessary.
- Pay special attention to provider-detection ownership — multiple tasks needing to know "which provider am I running on?" must agree on a single mechanism.
```
