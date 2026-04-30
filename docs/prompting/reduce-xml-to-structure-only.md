# Reduce XML to structure-only use

## Summary

This workspace uses XML-like wrappers in two very different ways today:

1. **Structure/display wrappers** that mark transcript metadata, system reminders, teammate messages, channel messages, background task notifications, and slash-command markers.
2. **Behavioral or machine-contract XML** where downstream code expects the model or another subsystem to emit a specific tagged shape and parses it programmatically.

The repo is not simply “too XML-heavy.” The real problem is that some prompt/control surfaces still rely on XML as an implicit behavioral protocol, and several code comments already describe those wrappers as being “for Claude.” That is the exact provider-blind risk this Phase 0 task is meant to identify.

The design recommendation is:

- keep XML where it is only a **transport/display envelope** or a **strict machine-readable contract** with a local parser
- stop using XML tags as a vague behavioral cue on GPT/OpenAI paths when plain text, typed metadata, or JSON would be clearer
- explicitly inventory GPT/OpenAI’s own XML-like authority wrappers too, not just Claude-shaped teammate/channel envelopes
- introduce provider-aware formatting at the message assembly boundary for teammate/channel/control-message injection, while leaving UI/rendering and parser-backed machine contracts alone for now
- treat transcript/UI coupling as a sequencing constraint: some wrapper generators currently serve both model delivery and UI parsing, so provider-facing format changes need either split transport or dual representation

In short: **XML should survive as structure, not as the main behavioral control surface.**

---

## Relevant files

### Central tag definitions

- `src/constants/xml.ts`
- `src/utils/xml.ts`
- `src/utils/displayTags.ts`

### Prompt/instruction surfaces that mention or wrap XML-like tags

- `src/constants/prompts.ts`
- `src/utils/api.ts`
- `src/services/api/instructionAssembly.ts`
- `src/utils/messages.ts`
- `src/utils/sideQuestion.ts`
- `src/tools/SkillTool/prompt.ts`
- `src/tools/ToolSearchTool/prompt.ts`
- `src/tools/AgentTool/prompt.ts`
- `src/memdir/memoryAge.ts`
- `src/tools/FileReadTool/FileReadTool.ts`

### XML used to inject control/context messages into the conversation

- `src/hooks/useInboxPoller.ts`
- `src/utils/swarm/inProcessRunner.ts`
- `src/utils/teammateMailbox.ts`
- `src/services/mcp/channelNotification.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/tasks/LocalShellTask/LocalShellTask.tsx`
- `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`
- `src/utils/task/framework.ts`
- `src/components/PromptInput/PromptInputQueuedCommands.tsx`
- `src/tools/AgentTool/forkSubagent.ts`
- `src/query.ts`
- `src/screens/REPL.tsx`

### XML parsing / rendering / filtering consumers

- `src/components/messages/UserTeammateMessage.tsx`
- `src/components/messages/UserChannelMessage.tsx`
- `src/components/messages/UserTextMessage.tsx`
- `src/components/MessageSelector.tsx`
- `src/components/VirtualMessageList.tsx`
- `src/utils/messages.ts`
- `src/QueryEngine.ts`
- `src/utils/transcriptSearch.ts`
- `src/bridge/bridgeMessaging.ts`
- `src/bridge/initReplBridge.ts`

### Machine-contract XML with local parsers

- `src/utils/permissions/yoloClassifier.ts`
- `src/coordinator/coordinatorMode.ts`

---

## Current XML usage categories

### 1. Safe shared structure: XML as transcript or display envelope

These uses are mostly structural. The system or UI wraps content so the transcript and renderers can recognize message origin or hide metadata.

#### a. System reminders and injected context

- `src/utils/api.ts:463` prepends resolved context as a synthetic user message wrapped in `<system-reminder>`.
- `src/services/api/instructionAssembly.ts:72` prepends OpenAI/GPT user context with its own `<gpt-system-reminder>` wrapper.
- `src/utils/messages.ts:3100` exposes `wrapInSystemReminder()`.
- `src/constants/prompts.ts:137` and `src/constants/prompts.ts:204` explicitly teach the model that `<system-reminder>` tags are system-added metadata, not user intent.
- `src/memdir/memoryAge.ts:45` wraps stale-memory caveats in `<system-reminder>`.
- `src/tools/FileReadTool/FileReadTool.ts:706` emits file-read warnings in `<system-reminder>`.
- `src/utils/transcriptSearch.ts:117` strips `<system-reminder>` blocks from transcript search/title derivation.
- `src/utils/displayTags.ts:1` generically strips XML-like wrappers from UI titles.

This is structurally important, but it is not a strong candidate for provider-specific removal in this task. The tag is being used as a metadata envelope with explicit instructions and matching UI logic. However, the OpenAI path already has its own XML-like authority wrapper (`<gpt-system-reminder>`), so the XML-reduction problem is not limited to Claude-shaped teammate/channel envelopes.

#### b. Terminal / command / slash-command wrappers

- `src/utils/messages.ts:581` emits `<command-name>` and related command metadata.
- `src/utils/processUserInput/processSlashCommand.tsx:788` and `:795` emit command/skill tags.
- `src/screens/REPL.tsx:3242` and `:4873` wrap local command stdout in `<local-command-stdout>`.
- `src/query.ts:315` emits a `<local-command-stdout>` message for account switches.
- `src/QueryEngine.ts:596` and `:623` detect these wrappers to treat them as non-user text.

These are transcript-typing envelopes. They are not ideal prompt prose, but they are not the main provider-blind control problem.

#### c. Task notifications and background task lifecycle

- `src/tasks/LocalAgentTask/LocalAgentTask.tsx:252`
- `src/tasks/LocalShellTask/LocalShellTask.tsx:80`
- `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:172`
- `src/utils/task/framework.ts:281`
- `src/components/PromptInput/PromptInputQueuedCommands.tsx:36`
- `src/coordinator/coordinatorMode.ts:144`

These all rely on `<task-notification>` wrappers and child tags like `<task-id>`, `<status>`, and `<summary>`.

This usage is partly structural and partly contractual. The XML is not just decoration, but it is also not vague prompt control: the system emits a typed wrapper and local code/prompt instructions interpret it consistently.

#### d. Fork boilerplate and UI-collapsible wrappers

- `src/tools/AgentTool/forkSubagent.ts:172` emits `<fork-boilerplate>`.
- `src/tools/AgentTool/forkSubagent.ts:86` searches for it to collapse boilerplate in the transcript.

This is clearly structure-only and should remain in the “safe shared” bucket.

---

### 2. XML used as behavioral control surface

These are the main hotspots for this Phase 0 task.

#### a. Teammate-message injection is explicitly Claude-shaped

- `src/hooks/useInboxPoller.ts:810` says “Format messages with XML wrapper for Claude”.
- `src/hooks/useInboxPoller.ts:818` emits `<teammate-message teammate_id="..." ...>...</teammate-message>`.
- `src/utils/swarm/inProcessRunner.ts:454` says it formats messages as XML for injection into the conversation so the model sees them in the same format.
- `src/utils/swarm/inProcessRunner.ts:465` emits the same wrapper.
- `src/utils/teammateMailbox.ts:386` also formats mailbox deliveries as `<teammate-message>`.

This is not just transcript rendering. The wrapper is being injected into the model-visible conversation so the model infers message origin and handling behavior from XML tags and attributes.

On Claude, this likely works well because the model is comfortable with XML-ish prompt structure. On GPT, this is a weaker and less native control surface. The tag is doing semantic work that should instead be owned by a provider-aware message formatter.

#### b. Channel notifications are injected via `<channel>` wrapper

- `src/services/mcp/channelNotification.ts:8` says the handler wraps content in a `<channel>` tag and enqueues it.
- `src/services/mcp/channelNotification.ts:43` describes `meta` as content rendered as attributes on the `<channel>` tag.
- `src/services/mcp/channelNotification.ts:115` emits `<channel source="..." ...>content</channel>`.

This is again not merely UI structure. The model is expected to infer source, context, and reply routing from an XML envelope in the user-visible conversation.

The XML wrapper is also doing metadata transport through XML attributes, which is convenient but Claude-shaped as a prompt convention.

#### c. Coordinator prompt teaches XML as the re-entry protocol

- `src/coordinator/coordinatorMode.ts:144` says worker results arrive as user-role messages containing `<task-notification>` XML and instructs the coordinator to distinguish them by opening tag.
- `src/coordinator/coordinatorMode.ts:148` onward embeds the XML format directly in the coordinator prompt.

This is a control contract expressed in XML inside model instructions. It is more justified than teammate/channel wrappers because the coordinator genuinely needs a structured re-entry contract, but it is still XML-based behavioral control rather than a provider-neutral structured handoff.

This should likely coordinate with the separate Phase 0 task on **Structured handoff contracts**, not be rewritten independently here.

#### Teammate-specific planning status

Teammate is a live XML surface and the planning for it should be considered complete at the design level, even if implementation happens later.

**Current shape**
- generation sites:
  - `src/hooks/useInboxPoller.ts:818`
  - `src/utils/swarm/inProcessRunner.ts:465`
  - `src/utils/teammateMailbox.ts:386`
- rendering / filtering consumers:
  - `src/components/messages/UserTeammateMessage.tsx:25`
  - `src/components/messages/UserTextMessage.tsx:153`
  - `src/components/MessageSelector.tsx:788`

**What the XML is doing today**
- identifies sender identity via `teammate_id`
- carries optional presentation metadata (`color`, `summary`)
- marks a user-role message as teammate-originated rather than human-authored
- gives the UI a detection/parsing hook
- gives the model a Claude-shaped semantic envelope for teammate-originated content

**Planned direction**
- teammate should remain in the XML planning inventory
- teammate should be treated as a **message transport / handoff contract**, not as a mere prompt-string cleanup
- the long-term replacement should be a typed contract or structured handoff object, with provider-facing formatting derived from that contract rather than XML being the source of truth

**Replacement options considered**
1. **Typed internal object + provider formatter**
   - internal shape carries `from`, `text`, `color`, `summary`, and message kind
   - Claude formatter may still emit XML initially
   - GPT formatter emits deterministic non-XML structure
   - UI reads typed metadata instead of reparsing XML
2. **JSON payload in user text**
   - better than ad hoc XML for GPT, but still mixes transport and display and is less attractive than typed metadata
3. **Keep XML as transport forever**
   - acceptable only as a temporary compatibility path, not the target end state

**Recommended choice**
- use **typed internal object + provider formatter** as the target design
- allow an interim compatibility period where XML is still emitted for Claude/UI while typed metadata is introduced underneath

**Dispatch location**
- generation ownership stays with:
  - `src/hooks/useInboxPoller.ts`
  - `src/utils/swarm/inProcessRunner.ts`
  - `src/utils/teammateMailbox.ts`
- but they should call a shared formatter / serializer built from a typed teammate-message contract

**Implementation dependency**
- teammate migration should be coordinated with **Structured handoff contracts**
- it does not need to be implemented in the same batch as instruction-wrapper cleanup
- but it is planned enough now that it should not be forgotten or rediscovered later

#### d. Side-question wrapper uses `<system-reminder>` as prompt control

- `src/utils/sideQuestion.ts:61` wraps side questions in `<system-reminder>` and instructs the model to answer directly.

This is an explicit authority/control wrapper in model-visible text, not just passive metadata. It is still lower priority than teammate/channel message envelopes because it is tightly coupled to instruction assembly, but it should be treated as an active prompt-control surface and reviewed as part of provider-aware instruction assembly rather than treated as permanent shared prompt structure.

---

### 3. XML-backed machine contracts that are valid and should not be lumped in with “bad XML”

These do use XML heavily, but they are not just hand-wavy prompting.

#### a. Permission classifier output parsing

- `src/utils/permissions/yoloClassifier.ts:801` parses stage 1 output with `parseXmlBlock(stage1Text)`.
- `src/utils/permissions/yoloClassifier.ts:887` parses stage 2 the same way.
- `src/utils/permissions/yoloClassifier.ts:924` and `:926` extract reasoning and the final reason from XML.

This is a strict machine contract with a parser and a safety fallback. It is fragile in the sense that it depends on tagged output, but it is not the same problem as “Claude likes XML wrappers.”

For this task, this should be treated as **structured output** territory, not generic XML cleanup. It may eventually move from XML to JSON or strict provider-native structured output, but that belongs with the separate Phase 0 task on **Strict structured outputs**.

There is already a migration foothold for this elsewhere in the repo: some flows already use provider-enforced JSON schema output instead of XML/prose, for example `src/memdir/findRelevantMemories.ts:109`. That makes parser-backed XML replacement more plausible later, but it should still be handled in the structured-output track rather than here.

#### b. Teammate-message wrapper plus JSON payloads inside

- `src/components/messages/UserTeammateMessage.tsx:25` parses teammate wrappers with a regex.
- `src/components/messages/UserTeammateMessage.tsx:68`, `:102`, and `:118` then try to parse the wrapped body as JSON for idle/task-completed notifications.

This is an example of XML as an outer envelope carrying semantically richer inner content. The parsing works, but it is also a sign that the XML wrapper is partly standing in for a proper typed transport.

---

### 4. Likely removable or questionable XML usage

These are not all urgent, but they are good candidates to trim or replace.

#### a. XML wrappers whose only purpose is model interpretation

The biggest examples are:

- teammate message envelopes in `src/hooks/useInboxPoller.ts:818`, `src/utils/swarm/inProcessRunner.ts:465`, and `src/utils/teammateMailbox.ts:386`
- channel message envelopes in `src/services/mcp/channelNotification.ts:115`

These should be the first candidates for provider-aware replacement because their main job is to tell the model “what kind of message this is.”

#### b. Prompt surfaces that mention tag semantics in shared prose

- `src/constants/prompts.ts:137` and `:204`
- `src/tools/SkillTool/prompt.ts:194`
- `src/tools/ToolSearchTool/prompt.ts:40`
- `src/tools/AgentTool/prompt.ts:197`

These are not necessarily wrong, but they indicate that XML/tag handling has become part of the general behavioral prompt corpus. That is acceptable for transcript metadata, but it should be reduced where tags are acting as behavioral protocol rather than just “system metadata may appear.”

---

## Design recommendation

### Principle

Split XML uses into three classes and treat them differently:

1. **Structure/display XML** → keep shared
2. **Machine-contract XML with real parsers** → keep for now, but treat as structured-output work, not prompt-style control
3. **Behavioral-control XML injected for the model to interpret** → add provider-aware formatting and reduce XML reliance on GPT paths first

---

### What XML is safe to keep shared

Keep these as-is for this Phase 0 slice:

- `<system-reminder>` wrappers used for system metadata and context injection
- transcript/display wrappers for command output and non-user messages
- `<fork-boilerplate>` for transcript collapsing
- `<task-notification>` as an existing typed notification envelope, unless and until the handoff-contract task replaces it wholesale
- parsing/rendering helpers like `src/utils/displayTags.ts`, `src/components/messages/UserChannelMessage.tsx`, and `src/components/messages/UserTeammateMessage.tsx`

Rationale: these uses are structural, already have UI consumers, or act as explicit local contracts rather than vague prompt cues.

---

### Which XML uses need provider-specific behavior

#### 1. Teammate and inbox message injection

**Current behavior**
- XML wrapper is generated directly in `src/hooks/useInboxPoller.ts`, `src/utils/swarm/inProcessRunner.ts`, and `src/utils/teammateMailbox.ts`.
- The model is expected to understand speaker/source/type from XML tag names and attributes.

**Recommended provider-aware behavior**
- **Claude path:** may keep the current XML envelope initially.
- **GPT path:** use a plain-text or JSON-lite preamble owned by a provider-aware formatter, for example a deterministic text structure such as:
  - `Teammate message from alice`
  - `Summary: ...`
  - `Content: ...`

The important change is that GPT should stop depending on tag interpretation for message semantics.

**Sequencing constraint**
- These generation sites currently feed both the model-visible conversation and the transcript/UI path.
- `src/components/messages/UserTeammateMessage.tsx:25` and `src/components/MessageSelector.tsx:788` parse/detect the existing XML directly.
- So a safe first slice cannot simply swap the generator output for GPT unless the code also introduces split transport, dual representation, or typed origin metadata for the UI.

**Dispatch location**
- Introduce a dedicated formatter near the injection boundary, not in the UI parser layer.
- Best candidates:
  - `src/hooks/useInboxPoller.ts`
  - `src/utils/swarm/inProcessRunner.ts`
  - `src/utils/teammateMailbox.ts`
- Shared implementation helper could live in a new module such as `src/utils/messageEnvelope.ts` or `src/services/api/controlMessageFormatting.ts`.

#### 2. Channel notification injection

**Current behavior**
- `src/services/mcp/channelNotification.ts:115` serializes channel source/meta into XML attributes and body text.

**Recommended provider-aware behavior**
- **Claude path:** current XML wrapper can remain initially.
- **GPT path:** render source/meta as explicit structured prose or a compact JSON block in the message body, rather than XML attributes.

For example, GPT should receive a deterministic context banner owned by code, not by XML interpretation.

**Sequencing constraint**
- `src/components/messages/UserChannelMessage.tsx:15` parses the current `<channel>` wrapper directly.
- As with teammate messages, changing generation format safely requires separating provider-facing formatting from transcript-facing rendering or adding typed metadata first.

**Dispatch location**
- `src/services/mcp/channelNotification.ts` is the correct owner because that is where the wrapper is currently generated.
- The formatter should branch before the content is enqueued into the conversation.

#### 3. Side-question/system-reminder authority wrappers

**Current behavior**
- `src/utils/sideQuestion.ts:61` uses `<system-reminder>` to frame high-priority side-question instructions.
- `src/utils/api.ts:463` uses `<system-reminder>` for injected user context.

**Recommended provider-aware behavior**
- Do not remove `<system-reminder>` yet, but coordinate this with **Role-native instruction hierarchy**.
- For GPT, authority should increasingly come from provider-native instruction placement rather than a synthetic XML wrapper attached to a user message.

**Dispatch location**
- This belongs with provider-aware instruction assembly, not ad hoc per callsite.
- Coordinate with `src/services/api/instructionAssembly.ts` and the instruction-hierarchy report.

---

### Which XML uses can be removed entirely

None should be deleted blindly in this report slice.

The repo has too many XML consumers for a safe blanket deletion. Instead:

- remove **GPT-path reliance** on XML interpretation first
- keep existing Claude-path wrappers where they are currently load-bearing
- defer parser-backed or UI-backed XML removal until the replacement transport exists

The report’s purpose is to identify where XML is acting as control, not to erase working local contracts prematurely.

---

### Where provider dispatch should live

There is no single universal XML dispatch point today because wrappers are created in several subsystems. The clean boundary rule should be:

- **Dispatch where model-visible envelope text is generated**, not where UI later parses it.

Concretely:

1. **Instruction/context wrappers**
   - owned by provider-aware instruction assembly
   - coordinate with `src/services/api/instructionAssembly.ts`

2. **Teammate/inbox/control-message wrappers**
   - owned by formatter helpers called from:
     - `src/hooks/useInboxPoller.ts`
     - `src/utils/swarm/inProcessRunner.ts`
     - `src/utils/teammateMailbox.ts`
     - `src/services/mcp/channelNotification.ts`

3. **Machine-contract XML**
   - do not branch ad hoc here in this task
   - coordinate with structured-output and handoff-contract work

---

### Suggested staged implementation order

#### Slice 1: provider-aware control-message formatting

Create a shared formatter for model-visible injected control messages:

- teammate messages
- channel messages
- possibly other envelope-style injected notifications

Goal:
- Claude can keep XML if desired
- GPT gets deterministic non-XML structure

Precondition:
- do not mutate the single shared wrapper string in place if the UI/transcript layer still depends on it
- first introduce split transport, dual representation, or typed origin metadata so provider-facing format can diverge without breaking `UserTeammateMessage`, `UserChannelMessage`, and selector logic

This is the highest-value XML reduction because these wrappers are currently described in code as being “for Claude”.

#### Slice 2: move authority away from `<system-reminder>` where appropriate

Coordinate with the instruction-hierarchy work so GPT gets native instruction placement instead of synthetic XML wrappers whenever possible.

#### Slice 3: review parser-backed XML contracts separately

- permission classifier XML belongs with strict structured outputs
- task notification / coordinator XML belongs with structured handoff contracts

---

## Risks

1. **Breaking UI/rendering by touching wrappers too early**
   - Components such as `src/components/messages/UserTeammateMessage.tsx:25` and `src/components/messages/UserChannelMessage.tsx:15` parse the current wrappers directly.
   - Mitigation: branch at generation time for provider-facing messages, but preserve existing transcript/UI wrappers until downstream consumers are migrated deliberately.

2. **Mixing this task with structured-output refactors**
   - `src/utils/permissions/yoloClassifier.ts:801` is a strict parser-backed contract, not just prompt fluff.
   - Mitigation: do not rewrite classifier XML in this task; note dependency on **Strict structured outputs**.

3. **Mixing this task with handoff-contract redesign**
   - `src/coordinator/coordinatorMode.ts:144` uses XML as the worker re-entry format.
   - But the contract is broader than the coordinator prompt alone: the same notification mode is emitted by `src/tasks/LocalAgentTask/LocalAgentTask.tsx:252`, `src/tasks/LocalShellTask/LocalShellTask.tsx:80`, `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:172`, and `src/utils/task/framework.ts:281`.
   - Mitigation: keep this task focused on reducing provider-blind prompt/control XML, and coordinate worker-result contract changes with **Structured handoff contracts** across both prompt and runtime plumbing.

4. **Prompt drift across providers**
   - If GPT gets plain text while Claude keeps XML, behavior may diverge in subtle ways.
   - Mitigation: keep semantic content identical; only change envelope format.

5. **Over-correcting by deleting useful structure**
   - `src/utils/displayTags.ts:1` and related renderers rely on wrappers to keep the UI sane.
   - Mitigation: preserve structure-only XML and only target model-control surfaces first.

---

## Implementation-ready plan

This section is the coding handoff. Another model should be able to start implementation directly from it.

### Track A — Instruction-side XML authority wrappers

**Goal**
Reduce XML-like behavioral control on live instruction surfaces without touching teammate/channel/task transport yet.

**Files to change first**
- `src/services/api/instructionAssembly.ts`
- `src/utils/sideQuestion.ts`
- `src/utils/api.ts`
- `src/constants/prompts.ts`

**Concrete implementation goals**
1. Replace or reduce GPT-only `<gpt-system-reminder>` usage in `src/services/api/instructionAssembly.ts`.
   - Keep the semantic content.
   - Prefer provider-native plain structured text over XML-like tags on the OpenAI path.
2. Reduce XML authority framing in `src/utils/sideQuestion.ts`.
   - Keep the exact behavioral constraints.
   - Stop relying on `<system-reminder>` as the main authority marker if a plain provider-owned preamble works.
3. Review `src/utils/api.ts:prependUserContext()`.
   - Do not delete it blindly.
   - Decide whether the shared `<system-reminder>` wrapper should remain for Claude-only compatibility or also move toward plain structured text.
4. Trim prompt wording in `src/constants/prompts.ts` so tag semantics are described as metadata handling, not as a general behavioral protocol.
   - Keep necessary mention of `<system-reminder>` because current runtime still emits it.
   - Avoid over-teaching XML/tag semantics beyond what the system still truly needs.

**Non-goals for Track A**
- Do not change teammate transport.
- Do not change channel transport.
- Do not change task-notification/coordinator XML.
- Do not change parser-backed XML output contracts.

**Verification for Track A**
- OpenAI/GPT path still receives all required user/runtime context.
- Side-question behavior remains unchanged.
- Claude path remains behaviorally stable.
- Search for remaining `<gpt-system-reminder>` and confirm whether any survivors are intentional.

### Track B — Teammate XML migration plan

**Goal**
Replace teammate XML as the long-term source of truth with a typed contract, while allowing compatibility during migration.

**Files that own teammate generation today**
- `src/hooks/useInboxPoller.ts`
- `src/utils/swarm/inProcessRunner.ts`
- `src/utils/teammateMailbox.ts`

**Files that consume teammate XML today**
- `src/components/messages/UserTeammateMessage.tsx`
- `src/components/messages/UserTextMessage.tsx`
- `src/components/MessageSelector.tsx`

**Concrete target design**
1. Introduce a typed teammate message contract carrying:
   - `from`
   - `text`
   - `color?`
   - `summary?`
   - message kind / origin marker
2. Add a shared serializer/formatter used by all three generation sites.
3. During migration, allow compatibility output for the existing transcript/UI path.
4. Move UI detection/rendering away from reparsing raw XML as the source of truth.
5. Once typed metadata is in place, provider-specific formatting can diverge:
   - Claude may keep XML longer if useful
   - GPT should receive deterministic non-XML structure

**Implementation order for Track B**
1. Add typed teammate contract and shared formatter.
2. Convert generation sites to build the typed contract first.
3. Preserve existing XML transcript behavior temporarily.
4. Migrate `UserTeammateMessage` and `MessageSelector` off raw-tag detection.
5. Only then consider changing GPT-facing teammate formatting.

**Non-goals for Track B**
- Do not redesign general task notifications here.
- Do not redesign worker result envelopes here.
- Do not mix channel migration into the same coding pass unless explicitly requested.

### Track C — Deferred but planned surfaces

These are part of the planning inventory but should not be changed in the first implementation batch unless explicitly requested.

- `src/services/mcp/channelNotification.ts` — channel XML transport
- `src/utils/permissions/yoloClassifier.ts` — parser-backed XML output contract
- `src/coordinator/coordinatorMode.ts` plus task emitters — worker/task notification XML contract
- `src/services/api/codex-fetch-adapter.ts` synthesized `call_id` compatibility behavior

### Recommended implementation order across tracks

1. **Track A first** — smallest live provider-facing XML cleanup with lowest runtime coupling.
2. **Track B second** — teammate migration after Track A is stable.
3. **Track C later** — only when working on structured outputs, handoff contracts, or GPT-native tool state.

### What a coding model should do next

If asked to start implementation now, it should:

1. read:
   - `src/services/api/instructionAssembly.ts`
   - `src/utils/sideQuestion.ts`
   - `src/utils/api.ts`
   - `src/constants/prompts.ts`
2. implement **Track A only** unless explicitly told to include teammate migration
3. avoid touching:
   - `src/utils/permissions/yoloClassifier.ts`
   - `src/coordinator/coordinatorMode.ts`
   - task notification emitters
   - teammate XML consumers unless the task is explicitly broadened to Track B

**Explicitly defer:**
- permission-classifier XML (`src/utils/permissions/yoloClassifier.ts`) → strict structured outputs work
- worker/task-notification XML contract (`src/coordinator/coordinatorMode.ts`, task files) → structured handoff contracts work
- channel XML transport (`src/services/mcp/channelNotification.ts`) unless explicitly requested
- GPT/OpenAI tool-state compatibility shims such as synthesized `call_id` values in `src/services/api/codex-fetch-adapter.ts:185` → GPT-native call-ID tool state work

---

## Verification strategy

### Static verification

- Search for comments or code paths explicitly saying wrappers are “for Claude” and confirm the GPT path no longer relies on those wrappers for injected teammate/channel messages.
- Confirm provider dispatch happens at wrapper generation sites, not just after the fact in rendering.

### Request-shape verification

For GPT/OpenAI sessions:
- confirm teammate/channel messages are injected without XML envelopes
- confirm the same semantic metadata still arrives in a deterministic format

For Claude sessions:
- confirm current XML envelopes still arrive unchanged for the initial slice

### Behavioral verification

- Send teammate messages and channel notifications on both providers and verify the model correctly distinguishes origin/source and responds appropriately.
- Verify no regression in task routing, plan approval, shutdown handling, or inbox delivery.

### UI/transcript verification

- Ensure transcript rendering remains correct for existing XML-backed messages.
- Ensure title extraction and display-tag stripping still behave correctly.

### Search-based follow-up verification

After Slice 1, re-search the workspace for:
- code comments that say wrappers are “for Claude” on still-shared GPT paths
- XML wrappers used only to tell the model what a message is, with no parser-backed contract behind them
