# What a peer exchange actually looked like, 2026-09-06

An observation report. One task, two sessions, six peer messages, two reports
to the user. Read end to end from both transcripts. It records what happened
and what is wrong with it. It proposes nothing.

## The run

| | Creator | Created |
|---|---|---|
| Peer name | Cavansite | Benitoite |
| App session | `d9f23423-17a6-473c-b039-378041336831` | `1011e903-002c-41bb-b0a7-a05c9ae639fe` |
| Engine session | `fc864d36-f5a0-4b32-82d3-fb1b9a6db08f` | `2ee22836-a712-4ce9-98c4-01d04f94748e` |
| Model | `gpt-5.6-terra`, medium | `gpt-5.6-luna`, xhigh |

The user had given Cavansite a plan document, revised it twice, and had it
reviewed through `cat-code-cold-review`. The whole instruction that started
this exchange was one line:

> send peer session Luna model to implement. use extra high effort.

The work itself came out fine: commit `6893ac24`, three files, every gate green.
This report is about everything around it.

## Timeline (UTC)

| Time | Who | What |
|---|---|---|
| 15:43:34 | Cavansite | `CreatePeer`, ~700-word brief |
| 15:43:35 | Benitoite | spawns |
| 15:44:12 | Benitoite | `ListPeers {all:false}` |
| 15:44:20 | Benitoite | `ReadPeer {peer:"Cavansite", maxBytes:32768}`, no query |
| 15:44:25 | Benitoite | message 1: read-back acknowledgment |
| 15:44:32 | Cavansite | spends a turn, tells the user "Benitoite has started" |
| 15:57:08 | Benitoite | message 2: status, no question |
| 15:57:21 | Cavansite | `SendToPeer` rejected, `InputValidationError` |
| 15:57:27 | Cavansite | message 3: countermand |
| 15:57:32 | Cavansite | tells the user "I directed Benitoite…" |
| 16:00:14 | Benitoite | message 4: full evidence report |
| 16:00:29 | Cavansite | verifies the commit itself |
| 16:00:52 | Cavansite | reports to the user |

## The finding

Cavansite wrote to a stranger, and everything downstream held that frame.

Not a formality problem and not a length problem. A stranger is someone who
does not have your instruction files, cannot ask you anything, and cannot be
trusted with the approach. Write to one and you restate the rulebook, pin the
method down, omit why the work exists, and demand a report in a fixed shape.
That is the brief, clause for clause.

## Evidence

### 1. The brief restated what Benitoite already had

It spelled out "follow the repository CLAUDE.md, preserve the hardening/security
baseline", the eight-command verification battery, and the commit rules:

> Commit your own explicit changed paths to the current `migration` branch with
> a conventional commit, per repository instructions. Do not push.

That sentence is `CLAUDE.md` §4 almost verbatim, and Benitoite loads `CLAUDE.md`
automatically. It is also self-refuting: it cites the repository instructions
*and* restates them. Citing is for a peer that has the document; restating is
for someone who does not. Doing both is not informing a colleague, it is
establishing that they are bound.

### 2. It carried every requirement and none of the situation

"Required implementation:" gives five bullets of JSX-level dictation, down to
which props to destructure. "Scope limits:", "Verification required after
implementation:", and a five-field report schema follow. Nowhere does it say
that the user reviewed a plan, what problem the change solves, or that the
prototype and a 2026-07-13 drift review are where it came from.

That omission has a measured cost. Thirty-six seconds into its first turn,
Benitoite called `ReadPeer` on its own creator with no `query` and a 32 KB
budget, and what came back was the plan's Problem and Background section: the
exact half the brief dropped. It went and fetched what Cavansite already had.

### 3. Benitoite read the order back

Message 1, before any code was touched:

> I'm starting the implementation in the assigned target files now. I'll inspect
> the current source/diffs first, then patch TranscriptView plus SSR and DOM
> tests, run the required desktop battery, update only the applicable STATUS
> row, and commit explicit paths. I'll report the SHA and outcomes back here.

Every phrase is lifted from the brief: "assigned target files", "the required
desktop battery", "commit explicit paths", and "update only the applicable
STATUS row" against the brief's "update only an applicable STATUS row if one
exists". It carries no information Cavansite did not write itself. It is a
read-back confirmation, the form used when someone will hold you to the
instruction, and it cost Cavansite a turn that produced one line for the user.

### 4. It had a question and did not ask it

Message 2 hit a real judgment call: the P4-18 STATUS row is a single ~13 KB
multi-writer line, an exact patch was rejected, and the choice was between
inserting a follow-up row and leaving the file alone. Instead of asking the one
peer who could settle it in a sentence, it announced its own resolution and
reassured:

> I'm resolving this without touching unrelated status content, likely via a
> narrowly inserted P4-18 follow-up row if exact same-line patch remains
> impractical. Target files remain cleanly scoped.

"Target files remain cleanly scoped" is a compliance statement against the
brief's scope limits. The hedged "likely via X if Y remains impractical" is
written so that whatever it does next was pre-announced. No question mark
appears in the message.

### 5. So the answer arrived as a countermand

Cavansite could not answer a question that was never asked, so it overrode a
decision already taken:

> Do not create a new STATUS follow-up row or modify the shared P4-18 line for
> this standalone task. Your brief required updating only an applicable exact
> row; none appears to exist. Report that STATUS was left unchanged rather than
> attempting another patch. Commit only the implementation/test files you
> personally changed, then send the full final report and SHA.

Four imperatives, the brief invoked as governing authority, and a dictation of
what the peer should *say* in its own report. The manager register is not only
Benitoite being deferential; the creator holds it too.

### 6. The final message is shaped to the brief's five fields

Message 4 runs about 200 words: gate counts, expectation totals, sweep results,
ordered as the brief's report schema asked for them.

The detail itself is not the fault, and an earlier draft of this report was
wrong to read it as posturing. `CLAUDE.md` §3 requires the commands and their
outcomes pasted in the final report, and the closing line of §11 makes pasted
battery output and a completed stale-reference sweep conditions of claiming
completion. Benitoite was meeting a repository requirement. What that
requirement does not account for is the creator dictating a five-field shape
for it, or the duplication in §8.

### 7. The frame reaches the user's screen

Cavansite's own turns, which the user reads:

> I **directed** Benitoite to leave `STATUS.md` unchanged … I'm **awaiting**
> its scoped commit and final **evidence**.

### 8. The same work is reported to the user twice

Both sessions close by writing the user a full completion report of the same
commit: SHA, changed files, STATUS rationale, all seven commands with results,
and GUI verification steps. Benitoite's adds file-by-file bullets, its `rg`
queries pasted verbatim with escaped quotes, and a seven-step operator
procedure with a four-variable launch command. It also includes:

> The initial PCRE negative-lookahead form of the suffix query was unsupported
> by the installed `rg`; the equivalent portable query above was rerun
> successfully.

That is the far end of the evidence detail. Whether §3's "commands and their
outcomes" reaches a note about a regex form that was replaced before it ran is
arguable, so it is recorded here as register rather than as a breach.

Benitoite is never told that a relay exists. From inside its tab an unsigned
ticket arrived and it delivered against it, so it writes a standalone report
for a client it has never spoken to. It is reporting to a stranger in the other
direction.

## What this cost

- One `ReadPeer` that fetched context the creator was holding.
- One read-back message, and the creator turn it consumed.
- One status message that withheld the question it was about, and the
  countermand that followed.
- Two full completion reports of one commit, to one human.

## What is not the problem

Checked and cleared, so they do not get re-litigated:

- **The doctrine is applied.** `buildDesktopSystemPrompt` in
  `app/sidecar/desktopSystemPrompt.ts` is unconditional, and both sidecars
  started hours after the last peer commit landed. The system prompt is not
  stored in a transcript, so this is inference from process start time and an
  unconditional code path rather than a quote from the record.
- **`ListPeers` at 15:44:12 is prescribed behavior**, not drift. The tool's own
  prompt opens with using it to find who else is working here, and `CLAUDE.md`
  says the same thing more firmly.
- **Asking to hear back was correct.** The user was waiting. What does not
  follow from the doctrine is turning that into a five-field form.
- **Cavansite's relay was honest.** It checked the committed diff itself before
  reporting, and it attributed the peer's part rather than presenting the work
  as its own.

## A separate defect

At 15:57:21 Cavansite called `SendToPeer` with `{to, summary, message}` and was
refused:

```
InputValidationError: SendToPeer failed due to the following issues:
The required parameter `text` is missing
An unexpected parameter `summary` was provided
An unexpected parameter `message` was provided
```

It retried correctly six seconds later. Two parameter names were invented that
have never been in the schema. `summary` is a field in the `SendToPeer` *result*
shape, so writing the output shape into the input is one candidate explanation,
and it is unverified.

## A candidate source for the register

The `Agent` tool's own description carries a delegation template, and the brief
corresponds to it closely. Under **Handoff completeness**,
`src/tools/AgentTool/prompt.ts` requires that a delegation prompt include
"exact file paths, the current state (uncommitted changes, prior failed
attempts, or dirty baseline the agent needs to know about), what 'done' looks
like, and any constraints the agent must follow", and under **Never delegate
understanding**, "include file paths, line numbers, what specifically to
change".

Each of those has a counterpart in the brief: the target file list, the
"Current shared-tree state" paragraph about other sessions' uncommitted work,
the verification battery as the completion condition, the "Scope limits"
section, and the JSX-level bullets. The shared-tree paragraph is the closest
correspondence, because nothing in `CreatePeer` asks for it while
"dirty baseline the agent needs to know about" does.

That text was available to Cavansite. The sidecar builds its tool list from the
engine's own `getTools` and appends the peer tools after it
(`app/sidecar/sessionController.ts`), so the `Agent` tool's description sits in
the same list as `CreatePeer`. Cavansite never called the tool.

**This is a matching source, not a demonstrated cause.** A dirty shared tree and
explicit completion criteria also follow from `CLAUDE.md` §4 and §3 on their
own, so the correspondence does not establish which text produced the brief,
and one exchange cannot separate them.

Two observations cut against the obvious reading of it:

- The same tool description already carries collegial framing, five lines above
  the checklist: brief the agent "like a smart colleague who just walked into
  the room", give it enough context "to make judgment calls rather than just
  following a narrow instruction", and "prescribed steps become dead weight when
  the premise is wrong". Whatever produced the brief, the enumerated checklist
  was followed and the framing immediately above it was not.
- No corrective was active. The `writing-handoff-prompts` skill teaches the
  distinction between what a recipient already has and what it lacks, and it is
  installed at user scope, but it is description-triggered on being asked for a
  prompt. "send peer session Luna model to implement" is not that, and it did
  not fire; Cavansite's only skill load was `cat-code-cold-review`.

## Open

- Which text produced the register. The `Agent` tool template above is the
  best-supported candidate, but the plan document and review skill already in
  Cavansite's context, and the general prior that handing work to another agent
  means writing a specification, point the same way. The transcripts cannot
  separate them.
- Whether one exchange is enough to generalize. This is a single pair, on two
  Codex models, on one task shape.
- Whether the duplication in §8 has any owner in the current instructions.
  The reporting requirements are written for one session reporting to the user.
