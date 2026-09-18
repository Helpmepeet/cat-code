# What the Model Sees in Cat Code

This document explains the boundary between Cat Code's internal state and the
information sent to the model.

## The central idea

The model does not see the Cat Code application directly. It only sees the
information that the harness serializes into a provider request.

```text
Cat Code internal state
  -> select and format relevant information
  -> provider request
  -> model
```

The request normally contains three important categories:

1. Instructions that define the agent's behavior and provide project context.
2. Conversation input, including earlier user and assistant messages.
3. Tool definitions that describe the actions available to the model.

The model does not literally read the surrounding API JSON. OpenAI validates
the request and converts roles, content, tools, and controls into the
model-specific representation used for inference. The exact hosted-model
markers are private implementation details.

## Message roles and provenance

At the provider boundary, normal conversation messages mainly use `user` and
`assistant` roles. A peer agent should not be represented by inventing a new
`peer` role. Cat Code can preserve where a message really came from with
internal provenance metadata instead:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "<cross-session-message from=\"Alex\">..."
  },
  "origin": {
    "kind": "peer",
    "name": "Alex",
    "appSessionId": "app-alex"
  }
}
```

`role` describes the message's position in the model protocol. `origin`
describes its real source inside Cat Code. Keeping those concepts separate is
important because a peer message must not be mistaken for human authorization.

Roles are not cosmetic labels. They carry conversational function and
instruction authority that the model learned during training. In simplified
terms:

```text
system     -> platform or harness-wide behavior
developer  -> application and agent instructions
user       -> the requested task
assistant  -> previous model output
```

Identity is separate. Alice, Bob, or a peer agent can all produce content that
enters the provider protocol as `user`; Cat Code must retain the actual sender
in provenance metadata. Unsupported invented roles such as `user1` or `peer`
should not be sent to the provider.

In the OpenAI Responses API, tool calls and tool outputs are structured input
items such as `function_call` and `function_call_output`. They should not be
confused with arbitrary speaker identities.

## Request settings that affect the model

Some request fields influence inference without becoming ordinary sentences
in the conversation:

| Setting | Purpose |
| --- | --- |
| `model` | Selects the model that executes the request |
| `reasoning.effort` | Controls how much reasoning work the provider permits |
| `reasoning.summary` | Requests a readable reasoning summary when supported |
| `tool_choice` | Makes tool use automatic, required, disabled, or forced |
| `parallel_tool_calls` | Allows several tool calls in one response |
| `text.format` | Constrains output to a structured schema |
| `service_tier` | Selects standard or priority processing |
| `stream` | Delivers response events incrementally |
| `store` | Controls provider-side response storage |
| `prompt_cache_key` | Supplies a stable identity used for prompt caching |

For example, the model normally does not read the sentence "your effort is
high." Cat Code maps the selected effort into a provider control:

```json
{
  "reasoning": {
    "effort": "high",
    "summary": "auto"
  }
}
```

The provider uses that control when running the model. Higher effort can spend
more reasoning tokens and time and may improve difficult answers, but it does
not guarantee correctness. The mechanism inside hosted models is not required
knowledge for a typical agent-engineering interview.

The useful distinction is:

```text
Messages and instructions tell the model what to reason about.
Request settings control how the provider runs that reasoning.
```

## Private reasoning and reasoning summaries

When a reasoning model answers, it may generate internal reasoning tokens
before producing the visible answer. Those tokens participate in the model's
generation process, so they influence what it produces next. They are not
normally exposed to the user or to Cat Code as readable text.

If Cat Code requests a reasoning summary, OpenAI may return a separate,
human-readable explanation of that reasoning:

```text
private reasoning tokens
  -> used internally by the model
  -> not normally shown

reasoning summary
  -> generated description of the reasoning
  -> visible to the user
  -> not a verbatim copy of the private reasoning
```

For continuity between turns, OpenAI can also return the reasoning state as an
opaque `encrypted_content` value. Cat Code stores that value in an internal
thinking signature and sends it back as a `reasoning` item on the next request.
Cat Code and the user cannot read the encrypted reasoning, but the provider can
use it to preserve reasoning context and prompt-cache continuity.

Therefore, three artifacts must not be confused:

1. Private reasoning that affects the model's answer.
2. A readable summary intended for the user.
3. Encrypted reasoning state used by the provider across turns.

### Should the summary be sent back to the model?

Do not copy the readable reasoning summary into a new `user` or `assistant`
message merely to remind the model of its earlier reasoning. That duplicates a
lossy explanation, consumes context, and can change the conversation prefix.

Preserve the provider's structured reasoning state instead. With a stateful
Responses conversation, use the response or conversation continuation
mechanism. When Cat Code manages context statelessly with `store: false`, it
requests `reasoning.encrypted_content` and replays that opaque value as a
structured `reasoning` item.

If the agent needs durable task memory, create a separate factual state summary
containing decisions, completed work, tool outcomes, unresolved issues, and the
next objective. That is agent memory or compaction, not a reasoning summary.

## What the model sees about tools

For each tool, the model sees a contract: its name, description, input schema,
and sometimes an output schema or strict-schema setting. It does not see the
tool's implementation, credentials, sandbox, or permission logic unless Cat
Code explicitly describes them in the prompt.

When the model wants to use a tool, it produces a structured function call.
The provider assigns a call ID and streams the structured item back to Cat
Code. Cat Code recognizes the item as a tool request, validates it, checks
permissions, executes the implementation, and returns the result with the same
call ID.

```json
{
  "type": "function_call",
  "call_id": "call_123",
  "name": "FileRead",
  "arguments": "{...}"
}
```

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "..."
}
```

`strict` only means the provider should make the generated arguments conform
to the declared schema. It is not a security mode. Cat Code must still validate
the arguments and enforce permissions around sensitive actions.

## What happens when the user interrupts

An interrupt first aborts the active request. The running model does not
receive a message in the middle of that cancelled generation. Cat Code then
records a synthetic interruption marker, such as
`[Request interrupted by user]`. If a tool was unfinished, its result is marked
as interrupted. The model can see those records on the next request and reason
about why the earlier turn stopped.

## What the model sees when a skill is loaded

A tool is an executable capability. A skill is a reusable playbook, usually
stored in `SKILL.md`, that teaches the model how to perform a kind of task.
There are two invocation paths.

### The user invokes `/skill-name`

Cat Code recognizes the slash command before sending anything to the model. It
resolves the skill, calls `getPromptForCommand()` to load and expand its
instructions and arguments, and constructs the messages for the next model
request.

```text
User types /pdf report.pdf
  -> Cat Code intercepts the slash command
  -> Cat Code loads and expands the pdf skill
  -> Cat Code injects the playbook into the request
  -> model receives the expanded playbook and starts following it
```

The model does **not** receive `/pdf` and then decide whether to call the
`Skill` tool. The harness has already performed the loading. It adds command
metadata, the expanded skill content, relevant attachments, and a permission
attachment carrying any allowed tools or model configured by the skill. The
request can also adopt the skill's configured effort setting.

This direct route is available only for a user-invocable skill. If its metadata
sets `userInvocable: false`, Cat Code refuses direct slash invocation and tells
the user to ask the assistant to use the skill.

### The model chooses a skill

Cat Code also exposes a `Skill` tool and a catalog of skills the model may
invoke. In that path, the model must first emit a structured tool call:

```text
Model calls Skill({ skill: "pdf" })
  -> Cat Code validates the requested skill
  -> Cat Code loads and expands its instructions
  -> Cat Code injects the playbook into the conversation
  -> model continues with the loaded instructions
```

Both paths eventually use essentially the same prompt-expansion machinery for
ordinary local skills. The difference is who made the decision:

```text
/skill-name typed by user -> harness loads it immediately
Skill tool called by model -> model requests it, then harness loads it
```

The injected playbook is internally constructed as a `user` message with
`isMeta: true`:

```ts
createUserMessage({
  content: skillInstructions,
  isMeta: true,
})
```

`isMeta` means that Cat Code considers it a synthetic metadata or control
message rather than text typed directly by the human. The provider generally
does not receive an `isMeta` field; it receives the playbook content under the
`user` role. Cat Code also includes command or skill-loading metadata so the
content is framed as an invoked playbook. In the model-invoked path, the model
additionally sees that this content follows its own `Skill` call.

There is a coordinator-mode exception: the main coordinator receives a short
delegation description instead of the complete playbook and tells a worker to
invoke the skill. The worker then receives the actual skill content.

This leads to an important design rule:

> A `user` role does not prove that a human wrote the message. Trust and
> authorization must come from Cat Code's provenance and permission system,
> not from the provider role alone.

## The boundary to remember

The model can reason only about information that reaches its context. Cat Code
may hold much more state—UI state, account credentials, permission decisions,
process handles, message origins, and internal flags—but the model cannot see
that state unless the harness converts it into instructions, messages, tool
definitions, or tool results.

## Interview summary

> Cat Code acts as the boundary between application state and model context. It
> converts selected instructions, messages, tool contracts, and tool results
> into the provider protocol. Internal fields such as message origin and
> `isMeta` help the harness preserve provenance even when the provider-facing
> role is `user`.
