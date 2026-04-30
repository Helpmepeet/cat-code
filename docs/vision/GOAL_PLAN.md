# Goal Plan: From Claude Code Fork to Personal Always-On Agent

**Status:** Draft v1 — 2026-04-02
**Working name:** TBD (not Claude Code, not openclaw — needs its own identity)

---

## Related Design Specs

- `AGENT_MODE_PLAN.md` — detailed design spec for Cat Code's orchestrated coding agent mode, kept separate from the broader always-on project plan

---

## Vision

Turn the server Mac into a dependable personal runtime node: an always-on agent that can code, research, automate, and manage tasks — controlled from the main Mac (or phone, eventually) over private networking.

This is not a cloud product. This is a two-Mac personal system:
- **Server Mac** — always-on execution host, runs the agent, stores memory, executes tasks
- **Main Mac** — human workstation and control surface, may sleep or disconnect at any time

The system must function independently on the server Mac even when the main Mac is unavailable.

---

## Milestones (in priority order)

### Phase 0: Provider-Native Foundations
These changes make the provider layer trustworthy before larger identity and orchestration work. See `docs/research/provider-differences.md` for the comparative research that motivates this phase, and `docs/prompting/phase0-prompt-pack.md` for the 8 investigation prompts plus the final coordination/conflict-resolution prompt.

- [x] **Role-native instruction hierarchy** — Claude and GPT must not share a fake common authority model. GPT should receive GPT-native instruction layering; Claude should keep Claude-native system prompt structure. See `docs/prompting/role-native-instruction-hierarchy.md` for the investigation report and design recommendation.
- [x] **Reduce XML to structure-only use** — XML-like wrappers may remain where they help readability or parsing, but they should not be relied on as the main behavioral control surface, especially on GPT paths. See `docs/prompting/reduce-xml-to-structure-only.md` for the investigation report and design recommendation.
- [x] **Remove visible-thinking dependence** — the system must not depend on replayed visible `<thinking>` text as state. Prompting and continuity rules should follow each provider’s native reasoning model. See `docs/prompting/remove-visible-thinking-dependence.md` for the investigation report and design recommendation.
- [x] **Prefix-friendly prompt assembly** — prompt construction should preserve a stable prefix and append dynamic session/task material late, so provider-native caching and control surfaces remain clean. See `docs/prompting/prefix-friendly-prompt-assembly.md` for the investigation report and design recommendation.
- [x] **Structured handoff contracts** — reliability-relevant agent/component handoffs now use structured contracts instead of loose prose, including the meaningful local teammate/direct transport paths; text-first behavior is limited to user chat, explicit control-message protocols, and cross-session constraints.
- [x] **Strict structured outputs** — outputs intended for downstream automation should use strict provider-aware structured schemas instead of loose formatting conventions.
- [x] **Schema-first tool contracts** — tool interfaces should become schema-first contracts with provider-aware constraints, not long prose descriptions with best-effort adherence. See `docs/prompting/schema-first-tool-contracts.md` for the implementation plan.
- [x] **GPT-native call-ID tool state** — GPT tool continuity must use call-ID-based state handling instead of Claude-style tool-result assumptions adapted onto the OpenAI path.
- [x] **GPT-native prompt style — Layer 1: Core system prompt** — The main system prompt sections (intro, system rules, doing tasks, actions, tool guidance, tone, output efficiency) must be rephrased in GPT-optimal instruction style (contracts, verification loops, completeness rules) while preserving identical behavioral rules. See `docs/prompting/gpt-native-style/layer1-core.md`.
- [x] **GPT-native prompt style — Layer 2: Built-in agent prompts** — Built-in agent system prompts (general-purpose, explore, plan, verification, guide) must be rephrased in GPT-optimal style. Depends on Layer 1 for the `isGPTPromptStyle()` router. See `docs/prompting/gpt-native-style/layer2-agents.md`.
- [x] **GPT-native prompt style — Layer 3: Service & maintenance prompts** — Internal model-to-model prompts (compaction, memory extraction, session memory, magic docs, auto-dream) must be rephrased in GPT-optimal style. Depends on Layer 1 for the style router. See `docs/prompting/gpt-native-style/layer3-services.md`.
- [x] **GPT-native prompt style — Layer 4: Tool descriptions** — Selectively rephrase tool description prompts that have complex behavioral guidance (BashTool, AgentTool, FileEditTool, etc.) in GPT-optimal style. Lowest priority. See `docs/prompting/gpt-native-style/layer4-tools.md`.

### Milestone 1: Agent Identity Shift
**The hardest milestone.** The current system — prompts, tool descriptions, UI copy, behavioral rules — all tell the model it is a "coding assistant." This must change so the model treats itself as a general-purpose personal agent that *also* codes. This touches the deepest layer of the existing codebase.

- [ ] Rewrite the core system prompt so the model sees itself as a general-purpose agent, not a coding assistant
- [ ] Remove or rewrite coding-specific behavioral guardrails that limit general agency
- [ ] Update tool descriptions and framing so tools are presented as agent capabilities, not developer utilities
- [ ] Remove Claude Code-specific onboarding, help text, and UX flows that assume a developer user
- [ ] Establish the agent's own personality and voice (equivalent of openclaw's SOUL.md)
- [ ] Ensure the model can naturally handle non-coding tasks (research, planning, automation, communication) without fighting its own instructions
- [ ] **Per-provider system prompts** — Claude and GPT behave differently under the same instructions (GPT is eager/literal, Claude is conservative/inferential). Behavioral instructions (task creation, verbosity, tool use judgment) must be written natively per provider, not patched onto a shared base. Shared building blocks (tool descriptions, env details) can be composed, but the behavioral layer must be provider-native.

### Milestone 2: New Name and Branding
Once the agent behaves differently, give it its own identity.

- [ ] Choose a name
- [ ] Replace all Claude Code branding (CLI name, splash, help text, about, user-facing strings)
- [ ] Write a new README that describes what this project actually is
- [ ] Clean up any remaining Anthropic-specific references that don't apply

### Milestone 3: Persistent Memory System
Give the agent memory that survives across sessions and grows over time.

- [ ] Always-loaded core memory (long-term facts, user profile, agent identity) — injected into context at every session start
- [ ] Daily notes — running log per day, today + yesterday auto-loaded
- [ ] Conversation logs — timestamped archive of every session, stored on disk
- [ ] Semantic search over memory — so the agent can recall things beyond what fits in the context window
- [ ] Self-curation — agent decides what to save on its own; flushes important context before compaction so nothing is lost

### Milestone 4: Server Mac as Runtime Host
Make the server Mac the real home of the agent, not just another machine.

- [ ] Agent runs as a durable background service on the server Mac (survives reboots, disconnects)
- [ ] Local workspace on the server Mac (not dependent on main Mac file access)
- [ ] Private connectivity between the two Macs (Tailscale + SSH or similar)
- [ ] Terminal-first remote control from the main Mac into the server agent
- [ ] Scheduled tasks and long-running jobs execute on the server Mac

### Milestone 5: Multi-Provider Orchestration
The main model is an orchestrator; sub-agents can use different providers.

- [ ] Clean provider abstraction — Anthropic and Codex as first-class, opencode as future option
- [ ] Orchestrator model delegates to sub-agents for specific work
- [ ] Sub-agents can run on different providers (e.g., cheap model for routine, strong model for hard problems). Partial progress: in-process teammate prompt/message formatting now follows the teammate's own provider instead of ambient session state.
- [ ] Provider selection logic (cost, capability, availability)
- [ ] Existing Codex account rotation continues to work under this model

### Milestone 6: Mobile / Remote Interface (Future)
Access the agent from anywhere, including phone.

- [ ] Decide on interface approach (find existing app, build custom, Discord bot, web UI, etc.)
- [ ] The agent on the server Mac accepts commands from this interface
- [ ] Works over unreliable/intermittent connectivity
- [ ] Supports async interaction (send task, get result later)

### Milestone 7: Task Queue and Autonomous Work
The agent picks up tasks and works on them without you present.

- [ ] Task queue the agent pulls from (could start as simple as a file or local DB)
- [ ] Tasks can be submitted from multiple sources (terminal command, GitHub event, scheduled trigger, future: phone/Discord)
- [ ] Agent works through queue items autonomously, logs results
- [ ] Agent can pause and resume tasks across sessions (using memory + task state)
- [ ] Notification when tasks complete or need human input

---

## Design Constraints

1. **Two-Mac architecture** — server Mac is the runtime, main Mac is the control surface
2. **Assume unreliable connectivity** between the two Macs (different networks, sleep, disconnects)
3. **Server Mac must be self-sufficient** — local workspace, local memory, local execution
4. **Private and local-first** — no cloud dependencies, no telemetry, all data on your machines
5. **Terminal-first** — SSH + Tailscale as the primary remote access pattern
6. **Reboot/disconnect tolerant** — background services, durable state, graceful recovery
7. **Incremental** — each milestone is usable on its own; no big bang rewrites

---

## What This Plan Is NOT

- Not an implementation plan (no file paths, no code, no PRs)
- Not a timeline (no dates, no estimates)
- Not final (milestones may reorder as priorities shift)
- Milestone 7 is deliberately vague — decision deferred

---

## Open Questions

1. What should the project be called?
2. What personality/voice should the agent have?
3. For Milestone 3: LaunchAgent, launchd service, or something else for background execution?
4. For Milestone 4: What's the simplest task queue that works? (file-based? SQLite? something else?)
5. For Milestone 5: How should the orchestrator decide which provider/model to use?
6. For Milestone 7: Build vs. find for mobile interface?

---

## Deferred Bugs / Follow-ups

- [ ] Design Claude account switching with fresh-session semantics and Codex-like UX. See `DEFERRED_TASK_claude_account_switching_design.md`.
- [ ] Investigate/fix upstream-style Claude usage-limit/session carry-over across account changes. See `DEFERRED_BUG_claude_usage_limit_carryover.md`.
- [ ] Fix Codex `/switch-account` stale-state carry-over. See `DEFERRED_BUG_stale_session_state.md`. This is separate from the upstream Claude Code multi-account usage-limit carry-over bug and should be addressed later.
- [ ] Revisit fullscreen streaming readability UX. Simple auto-unfollow thresholds were tested and reverted; use `docs/research/fullscreen-streaming-scroll-ux-findings.md` as the starting point for a better design.

## Lowest-Priority Deferred Work

### TypeScript rehab cleanup

Context: a repo-wide TypeScript rehabilitation pass was started after `/simplify` surfaced broader structural drift, including missing compatibility modules, stale SDK/control type surfaces, overlay hook signature mismatches, and several UI typing issues. The pass was intentionally stopped once the highest-value structural buckets were cleared, because the remaining work did not have a concrete product payoff and continuing broad cleanup was no longer token-efficient.

Completed high-value fixes from that pass:
- strengthened SDK control request typing so `src/cli/print.ts` narrows correctly again
- restored missing modules such as `src/keybindings/types.ts` and `src/utils/systemThemeWatcher.ts`
- fixed overlay/dialog hook signature drift across several UI surfaces

Leave the remaining TypeScript debt alone unless it directly blocks CI, a release, or work in the affected files.

Deferred buckets:
- [ ] UI env-comparison cleanup in `src/components/DevBar.tsx`, `src/components/Feedback.tsx`, `src/components/FeedbackSurvey/useMemorySurvey.tsx`, `src/components/LogoV2/feedConfigs.tsx`, and `src/components/MemoryUsageIndicator.tsx`
- [ ] UI narrowing cleanup in `src/components/agents/ToolSelector.tsx`, `src/components/Message.tsx`, and `src/components/messageActions.tsx`
- [ ] Transport typing cleanup in `src/cli/transports/ccrClient.ts`, `src/cli/transports/SSETransport.ts`, and `src/cli/transports/transportUtils.ts`
- [ ] Command/module resolution cleanup in `src/commands.ts`
- [ ] Message rendering union cleanup in `src/components/messages/CollapsedReadSearchContent.tsx`, `src/components/messages/GroupedToolUseContent.tsx`, and `src/components/messages/nullRenderingAttachments.ts`
