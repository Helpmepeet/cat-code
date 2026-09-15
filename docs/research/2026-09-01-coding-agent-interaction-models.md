# Coding-agent interaction models: Cat Code and current peer harnesses

**Research date:** 2026-09-01
**Cat Code source:** current `migration` branch after `e0dff4e5`, `80c988ff`, and `c5545655`
**External evidence:** the user-provided cross-product synthesis `coding-agent-interaction-research-2026-09-01.md`, based on official documentation, release notes, and public source inspection

## Executive summary

Coding-agent products are converging on one broad principle: **accept user input while work is active and preserve that intent visibly**. They are not converging on one Enter key or one meaning for “Send now.”

Three operations are becoming distinct:

1. **Queue**: reserve a message for a later turn.
2. **Steer**: provide new context at the next safe model boundary inside the current turn.
3. **Interrupt and send**: cancel the current foreground turn, preserve completed effects, and begin a selected message as a new turn.

Cat Code currently implements a hybrid of these:

- Enter while active creates a visible row labelled **Queued**, but the engine may consume it at the next tool-result boundary in the current turn. Semantically, this is cooperative steering with an after-turn fallback.
- The double-up icon labelled by tooltip as sending the next message now is an interruptive operation. It is closer to **Stop & send** than to the cooperative “Send now” used by Cursor and some other products.
- Ordinary Stop aborts the foreground turn but does not pause scheduling. A waiting message can start automatically after the abort boundary.
- Take-back is queue-wide rather than per-message.
- Foreground Bash, PowerShell, and synchronous subagents can move into background execution while preserving the same live process or agent iterator.

Cat Code is strong on engine continuity and race-safe interrupt targeting. It is behind richer desktop harnesses on explicit scheduling modes, per-message queue editing, queue pause/resume, and delivery-state vocabulary.

The primary product question is no longer whether busy input should be accepted. It is whether Cat Code should keep one hybrid lane or explicitly expose Queue, Steer, and Stop & send as separate user intentions.

## Evidence boundaries

### Cat Code

Cat Code statements below were verified directly against current source. Source is authoritative over older plans and reviews.

Relevant owners:

- Desktop submit, visible queue, take-back, send-now, and Stop: `app/renderer/src/App.tsx`
- Sidecar queue staging, force-send, recall, and boundary drain: `app/sidecar/sidecarServer.ts`
- Mid-turn engine consumption: `src/query.ts`
- Queue ordering: `src/utils/messageQueueManager.ts`
- Turn abort: `src/app-runtime/AppSessionController.ts`
- Background task transition: `app/sidecar/taskControlDomain.ts`
- Shell task lifecycle: `src/tasks/LocalShellTask/`
- Synchronous-agent transfer: `src/tools/AgentTool/AgentTool.tsx`

### Other products

External behavior is reported from the supplied research synthesis. It was not independently exercised in authenticated binaries during this Cat Code session. The synthesis distinguishes official documentation, release notes, inspected public source, and unknown behavior. This report preserves those limits.

## Vocabulary

| Term | Meaning in this report |
|---|---|
| Turn | One user-initiated unit that may contain several model requests and tool calls. |
| Queue | A later unit of work, normally FIFO and separate from the active turn. |
| Steer | New context delivered before a later model request inside the active turn. It cannot undo an already committed tool effect. |
| Interrupt and send | Cancel the current foreground turn and begin a selected pending message as a new turn. |
| Background | Release the foreground wait while preserving the same live task identity, execution, logs, and cancellation handle. |
| Stop barrier | Stop the foreground turn and prevent automatic queue dispatch until the user resumes it. |

# Part I: Cat Code today

## 1. Busy submission is hybrid steering, despite the `Queued` label

When a desktop turn is active, `app.submit` does not start a second controller turn. The sidecar:

1. mints a prompt UUID;
2. stores the full prompt in `stagedPrompts`;
3. enqueues it in the engine command queue as `mode: 'prompt'`, default priority `next`;
4. publishes `queued-prompts.snapshot` so the renderer can show it as pending.

The running query loop reads eligible queued commands after a tool batch, converts prompt commands to attachments, emits a command-lifecycle `started` signal, and removes the consumed commands (`src/query.ts`, the `queuedCommandsSnapshot` path around current lines 1917–2015).

The sidecar receives that lifecycle signal and commits the staged prompt to transcript history. Therefore the message can affect the **current turn** at the next model boundary.

If the active turn ends without another eligible boundary, the sidecar’s `drainOneQueuedPrompt()` dequeues the oldest prompt and starts a new turn for it.

This gives Cat Code the same broad hybrid behavior documented for current Claude Code CLI:

- same-turn steering when a safe tool/model boundary occurs;
- otherwise after-turn FIFO execution.

The UI currently calls both cases `Queued`. It does not tell the user whether the message is still waiting, has entered the active turn, or is guaranteed to run as a separate turn.

## 2. Visible pending-message surface

Cat Code renders waiting messages at the end of the transcript scroller rather than in a fixed dock. The surface has:

- one `Queued` caption over the stack;
- a dashed user-message preview for each staged prompt;
- a compact double-up icon for urgent delivery;
- a compact down-arrow icon for take-back;
- one live region around the changing rows, with controls outside it.

Current strengths:

- pending intent is visible;
- a staged message is not falsely inserted into transcript history before delivery;
- image-bearing prompts remain preserved engine-side;
- queue state is session-scoped in split panes;
- lifecycle frames clear stale pending rows when the process is gone.

Current limitations:

- no inline edit;
- no per-item remove;
- no drag or keyboard reorder;
- no per-item take-back;
- no explicit strict-queue versus steer mode;
- no visible delivery state beyond waiting versus disappearance into transcript history.

## 3. Enter while active

The composer stays editable during a running turn. Plain Enter submits through the same `app.submit` path used while idle.

Current meaning:

- if idle: start a turn immediately;
- if active: stage into the hybrid queue;
- if the query reaches a tool boundary: deliver within the active turn;
- if not: start a later turn after the active turn settles.

This behavior is close to Claude Code CLI and unlike queue-first defaults in Zed, Amp Neo, and default Gemini CLI.

## 4. Ordinary Stop

The renderer’s Stop control sends `app.abort` to the sidecar. `AppSessionController.abort()`:

- denies pending permission requests;
- aborts the active controller signal;
- invokes the adapter interrupt;
- preserves already emitted transcript and completed tool effects.

Ordinary Stop does **not** remove staged mid-turn prompts from the command queue. When the turn finalizer settles, the sidecar schedules its boundary drain. The oldest waiting prompt can therefore begin automatically.

Observable consequence:

> The user can press Stop and see Cat Code continue with the next waiting message.

That matches current documented Claude Code CLI behavior more closely than it matches the queue-pause recommendation in the external synthesis.

A separate cold-spawn `pendingSubmit` is different: Stop releases that renderer-held prompt back to the composer because no engine has accepted it yet.

## 5. Urgent send is interruptive Stop & send

The double-up action sends a sidecar-local `prompt.force` request containing:

- a renderer operation ID;
- the engine-minted UUID of the oldest visible waiting prompt.

The sidecar interrupts only if that UUID is still the current queue head. Once the prompt leaves the queue, a delayed or duplicate action is refused instead of retargeting cancellation to a successor turn.

After interrupting, the ordinary boundary drain starts the waiting prompt as a fresh turn.

This is semantically:

> **Stop the current response and send the oldest queued message next.**

It is not cooperative steering. The current compact control’s tooltip explains the cancellation, but the broader product language still calls the concept send-now. That phrase is ambiguous across the market:

- Cursor’s August 2026 Send now means safe-boundary steering without interruption.
- Zed uses Send Now for interruptive immediate delivery.
- Claude Desktop exposes Send now, but the supplied research could not establish its exact cancellation contract.

Cat Code’s engine contract is safe; the label is the product ambiguity.

## 6. Take-back

Take-back removes every still-staged main-thread prompt from the engine queue and returns the full prompt payloads to the renderer, including images.

The renderer restores the recalled content to the composer. The action is queue-wide, matching terminal-style “pop editable queue” semantics rather than modern desktop per-row editing.

Race handling is honest:

- if the engine has already consumed a prompt, recall does not pretend it came back;
- a late command-lifecycle signal can correct an earlier recall result;
- subagent-addressed work and task notifications are outside the recall filter.

## 7. Queue ordering and delivery

The engine queue has three priority classes:

1. `now`
2. `next`
3. `later`

Within a priority, dequeue is FIFO.

Desktop user prompts use `next`. Task notifications normally use `later`. The sidecar boundary drain gives a user prompt precedence over a worker result.

The desktop does not currently expose priority as a user choice. Its urgent action interrupts the active turn but does not rewrite a prompt to queue priority `now`; it relies on the ordinary prompt remaining at the head of the eligible queue.

## 8. Foreground and background work

Cat Code now exposes live task mode beside the activity row:

- `Foreground` status;
- `Background` action;
- existing background-task strip and Tasks dialog after detachment.

Eligible work includes:

- long foreground Bash commands;
- long foreground PowerShell commands;
- synchronous local subagents.

The sidecar calls the same engine `backgroundAll()` machinery as terminal Ctrl+B. Backgrounding is session-wide for eligible foreground work, not a selected-task operation.

### Shells

Long shell calls register a foreground task independently of terminal JSX. Backgrounding preserves the live `ShellCommand`, output file, task ID, and stop handle.

### Subagents

Synchronous-agent backgrounding now transfers the same live async iterator to a detached consumer. It does not restart `runAgent` from the original prompt. The transfer preserves:

- agent ID;
- already produced messages;
- the in-flight `next()` result;
- progress tracking;
- task output;
- cancellation controller;
- worktree and cleanup ownership.

While foregrounded, parent-turn cancellation is relayed to the task controller. After transfer, that relay detaches and task-stop owns the same controller used by the live iterator.

### Current limitations

- no selected foreground task backgrounding; the action backgrounds all eligible work;
- no general “return to blocking foreground wait” operation;
- task inspection and stopping exist, but foreground reattachment is not a product concept;
- ordinary foreground Stop and independently backgrounded work have different ownership, but this distinction is not deeply explained in the main chat UI.

## 9. Cat Code’s current state model

| User-visible state | Engine meaning |
|---|---|
| Draft | Renderer-local text, not accepted by engine. |
| Cold-spawn queued row | Renderer holds one prompt until a session is ready. |
| Queued dashed row | Sidecar accepted and staged the prompt; model has not consumed it yet. |
| Row disappears, user transcript row appears | Engine started consuming the prompt. |
| Foreground | An eligible shell or synchronous subagent is blocking the current turn. |
| Background | The same live work continues without blocking the foreground turn. |
| Stopping | Not currently represented as a durable explicit UI state. |
| Queue paused | Not currently supported. |
| Waiting to steer | Not distinguished from `Queued`. |
| Delivered | Implied by transcript insertion rather than a separate queue status. |

# Part II: Other harnesses

## Comparative matrix

| Product / surface | Busy Enter default | Explicit later queue | Steering | Interruptive send | Queue controls | Background work |
|---|---|---|---|---|---|---|
| **Cat Code desktop** | Hybrid: stage, then same-turn tool-boundary consumption or next-turn fallback | Not separate from hybrid lane | Implicit through hybrid queue | Double-up action interrupts and sends oldest staged prompt next | Visible rows; queue-wide take-back; no edit/reorder/remove | Bash, PowerShell, and synchronous subagents transfer live; visible task surfaces |
| **OpenAI Codex CLI** | Steer active turn | Tab queues FIFO later turns | Explicit/default Enter | Escape paths can interrupt and start pending steering as a fresh turn | Pending steer and ordinary queue previews; recall latest; no established arbitrary reorder | Long unified-exec process can survive turn interruption; background terminal management |
| **Claude Code CLI** | Hybrid pending input can enter same turn after tool batch | Ctrl+X then Enter documents queue submission | Hybrid Enter behavior | Escape stops current response/tool, then queued input can run next | Pending rows; bulk take-back through Up; no established arbitrary per-row management | Ctrl+B for Bash or agent; `/tasks` inspection and individual stop |
| **Claude Desktop Code tab** | Current docs describe correction after current action | Visible queue exists | Behavior described, exact lane semantics incomplete | Send now exists, exact cancellation contract not established by supplied evidence | Edit, remove, drag reorder, per-row Send now, right-click actions | Not established as a general desktop task-promotion model in the supplied evidence |
| **Gemini CLI** | Queue by default; experimental steering can change it | Tab also documented for queueing | Experimental model steering, off by default | No distinct public Send now established | Up edits queued input; richer current row controls not established | Background shells and Ctrl+B PTY promotion; subagent promotion not established |
| **Cursor Agents Window / web** | Surface-specific | Tab queues after turn | Send now means next-tool-call steering without interrupting | Separate interruption behavior; labels vary by surface | Queue ordering/editing exists on some surfaces | Shell continuation/background support; local/cloud handoff is a separate execution model |
| **Cursor IDE** | Enter queues | Yes | Cmd/Ctrl+Enter bypasses queue per current IDE guidance | Stop interrupts agent; exact queue fate unresolved | Drag ordering on supported surfaces | Shell backgrounding and completion notifications |
| **Cursor CLI** | First Enter steers | Queue support varies by version/surface | Safe-boundary steer | Another Enter can interrupt | Not fully established | Follow-ups can leave tools running in background |
| **GitHub Copilot CLI** | Steering documented, but docs conflict | Ctrl+Q / Ctrl+Enter queue pending work | Active-work steering | Cancellation semantics version-sensitive | Ordered local queue; pending cancellation hints; public rich manager not established | `/tasks`, selected kill, background promotion for shells/subagents |
| **Copilot SDK** | API-level choice | FIFO, one full turn per item | Immediate delivery before next model request | Not the same as steering; already committed tool calls survive | SDK contract, not a complete UI | Client-dependent |
| **VS Code chat/agents** | Default documentation conflicts | Add to Queue | Steer with Message | Stop and Send | Drag reorder within type | Background behavior depends on agent/tool host |
| **Amp Neo** | Queue-first since May 2026 | Yes | Double Enter steering at completed step | Double Escape forces interruption | Queue navigation/editing | Exact reattachment semantics not established |
| **Zed native agent** | Queue-first since July 2026 | Yes | Cooperative per-message Steer | Send Now / double Enter is interruptive | Per-message edit/remove plus queue management | Independent threads continue; external-agent steering limited by host visibility |
| **Augment IDE extensions** | Queue beta | Yes | Steering preference | Per-message Send now / urgent interruption | Edit, delete, reorder, send-now, pause/resume | Background semantics not central to supplied evidence |
| **Grok Build** | Supports queue and steering preference | Yes | Yes | Yes | Changelog shows active work on queue/edit safety | Active shells can background on incoming input; race fixes documented |

## Product-by-product notes

### OpenAI Codex CLI

Codex is steering-first:

- Enter steers the active turn.
- Tab explicitly queues later work.
- The UI distinguishes pending steering from ordinary queued follow-ups.
- Recall targets the latest queue item rather than the whole queue.
- Escape behavior depends on whether unconsumed steering exists.
- A long-running unified-exec process can survive turn interruption.

Codex has one of the clearest separations between “change current work” and “do later work,” but its keybindings are terminal-specific and not a direct desktop prescription.

### Claude Code CLI

Claude Code is the closest semantic relative to Cat Code:

- busy Enter creates pending input;
- pending input can enter the active turn after a tool batch;
- if the turn ends first, it can become the next turn;
- Escape stops current work and queued input may run next;
- Ctrl+B backgrounds Bash or a foreground agent;
- Up takes queued messages back together.

Cat Code desktop currently exposes this engine model more literally than Claude Desktop does. Its visible queue is richer than terminal Claude Code, but less editable than Claude Desktop’s Code tab.

### Gemini CLI

Gemini currently favors queue-first behavior by default, with steering as an experimental mode. This is evidence that vendors still regard steering as a meaningful policy choice rather than the inevitable meaning of Enter.

Its shell backgrounding supports live continuation, but the supplied evidence did not establish equivalent live subagent promotion.

### Cursor

Cursor demonstrates why the words alone are unsafe:

- “Send now” can mean cooperative next-tool-call steering.
- IDE Enter can mean queue.
- CLI Enter can mean steer, then interrupt on repetition.
- background shell and cloud handoff are distinct lifecycle concepts.

A Cat Code label should describe its actual cancellation boundary rather than borrow Cursor’s phrase.

### GitHub Copilot and VS Code

The clearest explicit three-way model appears in VS Code:

- Add to Queue;
- Steer with Message;
- Stop and Send.

Copilot SDK also separates immediate same-turn delivery from FIFO one-turn-per-item queueing. Public Copilot CLI behavior is less stable because current documents conflict and recent releases changed cancellation and queue behavior repeatedly.

### Amp, Zed, Augment, and Grok

These products show a queue-first desktop trend:

- stable visible rows;
- per-message editing and removal;
- explicit cooperative steering;
- explicit interruptive immediate send;
- queue pause/resume in richer implementations;
- repeated race fixes around rapid send-now, editing, cancellation, and late completion.

Their common lesson is not one shortcut. It is that scheduling intent must be explicit and serialized by the authoritative runtime.

# Part III: Where Cat Code fits

## Stronger than many peers

Cat Code already has several robust properties:

1. **Pending intent is engine-backed and visible.** A dashed row represents accepted-but-not-consumed input, not optimistic transcript history.
2. **Interruptive send is target-bound.** `prompt.force` names the engine-minted visible queue head, preventing a delayed action from aborting an unseen successor turn.
3. **Recall reports races honestly.** It distinguishes content actually recalled from content already consumed.
4. **Background means live continuation.** Shells preserve processes; subagents preserve the same iterator and task identity.
5. **N-process session isolation narrows queue scope.** Each sidecar owns one session’s queue and task store.
6. **Task ownership is engine-side.** Renderer controls name intent; the sidecar re-resolves live state.

## Behind richer desktop harnesses

Cat Code lacks:

1. a strict after-turn queue distinct from steering;
2. an explicit cooperative `Steer at next step` action;
3. a queue pause/resume state;
4. ordinary Stop as a scheduling barrier;
5. per-message edit, remove, take-back, and reordering;
6. explicit queue states such as Waiting to steer, Sending, Delivered, and Failed;
7. operation-level deduplication beyond target-state checks;
8. a selected-message Stop & send operation when several items are waiting;
9. a selected-task background action;
10. foreground reattachment as a supported lifecycle.

## Current semantic mismatches

### `Queued` can become same-turn steering

The row truthfully means “not yet consumed,” but the label does not tell the user whether it will steer the current turn or run later.

### Send-now is actually Stop & send

The engine behavior is interruptive. The compact tooltip is accurate, but the category name is ambiguous relative to current Cursor and other harnesses.

### Stop is not a stop barrier

Stop can be followed immediately by automatic queue dispatch. That is consistent with current Claude Code CLI, but conflicts with the stronger desktop recommendation that Stop leave the session stopped until the user resumes scheduling.

### Take-back is global

The UI displays individual rows but can only recall them as one set. Richer desktop queue managers let the user act on the row they selected.

# Part IV: Product choices

## Option A: Keep Claude Code parity

Preserve the current hybrid model:

- Enter while active means “steer if possible, otherwise run next.”
- Stop aborts current work and lets queued input continue.
- Take-back remains queue-wide.
- Urgent send interrupts and advances the oldest waiting item.

Advantages:

- matches the underlying engine;
- minimal new scheduler machinery;
- familiar to terminal Claude Code users;
- fast corrections can reach the current turn.

Costs:

- `Queued` is underspecified;
- Stop may surprise users by continuing;
- no strict “do this later” guarantee;
- richer queue rows promise more control than they provide.

## Option B: Adopt an explicit three-lane desktop model

Expose:

- **Queue**: strict later turn;
- **Steer at next step**: cooperative current-turn context;
- **Stop & send**: interrupt exact target turn and start selected item.

Ordinary Stop would pause dispatch. Each pending item would carry stable mode and state.

Advantages:

- clearest user intent;
- aligns with VS Code, Codex’s queue/steer distinction, and richer queue-first desktops;
- makes race contracts testable;
- avoids overloaded labels.

Costs:

- requires separate scheduler lanes rather than one command queue;
- requires queue pause state and turn/message identity on additional paths;
- creates deliberate divergence from terminal Claude Code;
- per-message editing and selection expand the boundary surface.

## Option C: Queue-first with one urgent action

A smaller redesign:

- Enter while active strictly queues.
- Add one explicit `Steer` action.
- Rename current urgent action `Stop & send`.
- Make ordinary Stop pause dispatch.
- Keep queue-wide take-back initially.

This captures most of the clarity benefit without immediately building a full queue editor.

# Part V: Recommended direction

The evidence favors **Option C as the next product step**, with Option B as the long-term model.

Recommended semantic contract:

1. **Enter while idle:** Send.
2. **Enter while active:** Queue for a later turn.
3. **Cmd/Ctrl+Enter while active:** Steer at next safe model step.
4. **Stop:** cancel the exact foreground turn and pause queue dispatch.
5. **Stop & send:** cancel the exact foreground turn and start the selected pending message once; preserve and pause all other entries.
6. **Take back:** operate on one row when per-message identity reaches the renderer action; retain a separate Take back all action.
7. **Background:** continue the same task identity and execution; never restart to satisfy the transition.
8. **Foreground:** mean that the current turn is waiting on this live work, not merely that the task is visible.

This is a product recommendation, not a statement that current Cat Code is broken. Current Cat Code is coherent as a Claude Code-compatible hybrid. The recommendation is to make desktop scheduling intent more explicit than the terminal engine’s historical defaults.

## Race contract for any redesign

| Race | Required behavior |
|---|---|
| Queue submission as turn finishes | Accept once and place in the next eligible slot. |
| Steer target already finished | Do not retarget a successor silently; convert to pending later work with a visible explanation. |
| Stop target already finished | Do not cancel the successor turn. |
| Duplicate action | Return the existing result for the same operation ID or an honest stale result; do not repeat side effects. |
| Stop & send twice | Start the selected message once. |
| Recall versus dispatch | Atomically return content or report Already sent. |
| Background versus completion | Return Completed; never launch a replacement task. |
| Stop versus queue drain | Stop establishes the pause barrier before acknowledging completion. |
| Disconnect before acknowledgement | Reconcile by operation and message ID; do not duplicate. |

# Conclusion

Cat Code currently looks like a **desktop visualization of Claude Code’s hybrid queue/steering engine**, strengthened with race-safe urgent send and true live task backgrounding.

The market is moving toward **visible pending intent plus explicit scheduling choices**, not toward one universal Enter shortcut. Codex, VS Code, Cursor, Zed, Amp, Augment, and Copilot expose different defaults, but together they support one conclusion: queueing, steering, and interruption are materially different user intentions.

Cat Code’s next design decision should therefore be explicit:

- keep Claude Code parity and name the hybrid behavior honestly; or
- make the desktop more predictable than the terminal by separating Queue, Steer, and Stop & send.

The current implementation is a safe base for either direction. The main unresolved product issue is ordinary Stop: whether it should continue draining pending work, as Claude Code CLI does, or become a scheduling barrier, as a desktop queue manager arguably should.
