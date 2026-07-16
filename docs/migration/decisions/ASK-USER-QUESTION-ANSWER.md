# AskUserQuestion answer seam — C5: the interactive-answer round-trip through the sidecar

**Status: DECIDED 2026-07-16.** Branch `migration`. Owns P4-20 (PARITY-LEDGER §7 "DANGER"
cluster — 7 unowned rows). This extends the permission-boundary family
(`decisions/PERMISSION-BOUNDARY.md` C1–C4) with one more inbound verb; it does **not**
reopen C1–C4 or any locked decision. All `src:line` / `app:line` anchors re-verified against
the working tree on 2026-07-16; where this doc and source disagree, **source wins**.

| # | Question | Verdict |
|---|---|---|
| **C5** | how a live-turn `AskUserQuestion` answer reaches the engine without the renderer authoring the tool's input | **DECIDED + IMPLEMENTED** — a new app-owned inbound frame `askUserQuestion.answer`. Per-question answer = **option-index selection** (C1 pattern: the sidecar re-attaches the engine's own option `label`s) **plus** an optional built-in "Other…" **freeform** string. The sidecar rebuilds `updatedInput` from the ENGINE's own gated `questions` and resolves through the existing `respondToPermissionRequest` allow path. Cancel/Esc reuses the existing `permission.response` deny. Zero `src/` changes. |

---

## 1. The problem — why the answer cannot ride `updatedInput`

`AskUserQuestion` (`src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`,
`ASK_USER_QUESTION_TOOL_NAME`) is a real, reachable, **interactive** tool:
`requiresUserInteraction() === true`, `checkPermissions()` returns
`{ behavior: 'ask', updatedInput: input }` (`:call`/`:checkPermissions`), and its `call()`
reads `input.answers` — a `Record<questionText, answerString>` — which
`mapToolResultToToolResultBlockParam` folds into the model-visible tool_result
("User has answered your questions: …"). In the TUI the answer is delivered by the
permission dialog calling `onAllow(updatedInput)` where `updatedInput = { ...input, answers }`;
the engine then runs the tool with that input (`appRuntimeCanUseTool.ts:61-81`
→ `normalizePermissionResponse` → `permissionPromptToolResultToPermissionDecision`).

So the answer is, at the engine level, **an `updatedInput.answers` on an allow**. But the
desktop sidecar boundary makes renderer `updatedInput` **echo-only** (SECURITY-MINIMUM T6,
`sanitizePermissionResponse` `app/sidecar/sidecarServer.ts:1523-1572`): a renderer allow's
`updatedInput` must be empty or deep-equal the gated input, and the sidecar forwards the
**gated** input regardless. A legitimate AskUserQuestion answer necessarily *differs* from the
gated input (it adds `answers`), so the T6 echo check would reject it — and even an empty allow
forwards `answers`-less input, yielding an empty answer. **This is exactly why the seam degrades
today** (the renderer has no AskUserQuestion renderer, and the one response verb it has cannot
carry an answer). The answer must therefore cross by a different, purpose-built mechanism.

## 2. The decision — `askUserQuestion.answer`, index-selection + freeform

A new **app-owned inbound frame** (like C2 `permission.setMode`, the P4-5 account verbs, etc.):
validated by a **sidecar-LOCAL** Zod schema, **not** added to the engine's shared
`appClientMessageSchema` (the WS server shares that and has no handler — R5/§3 of
PERMISSION-BOUNDARY.md). Wire shape (`app/shared/protocol.ts`):

```ts
type AskUserQuestionAnswer = {
  optionIndices: number[]   // indices into THIS question's engine-minted options[]
  other?: string            // the built-in "Other…" freeform answer (user-authored)
}
type AskUserQuestionAnswerMessage = {
  type: 'askUserQuestion.answer'
  requestId: string                 // the pending engine-minted permission requestId (T5a)
  answers: AskUserQuestionAnswer[]   // position-aligned to the gated `questions` array
}
```

**The central split (the part the prompt calls the architecture core):**

- **Option picks are a C1-style selection.** For every real option the model offered, the
  renderer sends the option's **index**, and the sidecar re-attaches the engine's own
  `options[i].label` — byte-for-byte the label the model authored, taken from the sidecar's
  own pending-request entry, **never from the wire**. This is precisely C1's "renderer selects,
  never authors" applied to option labels instead of `permission_suggestions`.
- **"Other…" is the irreducible freeform text C1 cannot reach.** The built-in freeform answer is
  genuine user-authored text; there is no engine object to select. It crosses as renderer bytes.
  This is **security-equivalent to `app.submit`**: the answer is model-visible *text* fed into a
  tool_result, never a privileged action (`AskUserQuestion.isReadOnly() === true`; its `call()`
  only echoes the answer string back to the model). A compromised renderer can already author
  arbitrary model-visible text via `app.submit`; the freeform answer grants nothing beyond that.

### Sidecar handling (`handleAskUserQuestionAnswer`, the T6-preserving core)

Order, fail-closed at each step (`bad_request`, request **stays pending** — the S2 §2 race):

1. **T5a** — `requestId` must match a currently-pending engine request
   (`getPendingPermissionRequests()`); unknown → `permission_not_found`. Reuses the exact lookup
   `handlePermissionResponse` uses. No path lets the renderer register a pending request.
2. **Tool gate** — `pending.request.tool_name === 'AskUserQuestion'`, else `bad_request`. This
   frame is valid **only** for an AskUserQuestion request; it can never answer a Bash/file gate.
3. **Read the gated questions from the ENGINE** — `extractGatedToolInput(pending.request).questions`
   (the same helper T6 uses), defensively narrowed to `{ question, options:[{label}], multiSelect }[]`.
   Every question text and option label the answer resolves to comes from **here**, never the wire.
4. **Validate the answer payload against the gated questions**: `answers.length` ===
   `questions.length`; per question, `optionIndices` are integers in `[0, options.length)` with no
   duplicates; `other` (if present) ≤ `MAX_QUESTION_ANSWER_CHARS`; at least one component present;
   a **single-select** question accepts at most one total component (index+freeform ≤ 1). Structural
   caps + the 128 KiB `MAX_FRAME_BYTES` decoder bound cover T7.
5. **Reconstruct** `answersMap[questions[i].question] =
   [...optionIndices.map(j => options[j].label), ...(other ? [other] : [])].join(', ')` — labels
   from the engine, freeform from the (bounded) wire, joined exactly as the tool's `outputSchema`
   documents ("multi-select answers are comma-separated").
6. **Resolve** `respondToPermissionRequest(requestId, { behavior: 'allow',
   updatedInput: { ...gatedInput, answers: answersMap } })`. The `questions`/`metadata` are the
   engine's own gated fields; only `answers` is attached. This rides the engine's normal decision
   path (`appRuntimeCanUseTool.ts` → tool `call({ answers })`) with **zero `src/` changes**.

The response is **built server-side by the trusted sidecar**, so it does not pass through the T6
renderer-echo check at all — T6 guards *renderer-supplied* `updatedInput`, and the renderer
supplies none here (it supplies indices + freeform). The `answers` map the sidecar constructs is
composed of engine-authored labels + freeform text already conceded to `app.submit`.

### Cancel / decline — reuse the existing deny

The "Cancel"/Esc affordance is a plain `permission.response` **deny** with the model-visible
message ("User declined to answer questions"); the engine's `cancelAndAbort` path already models
it (`renderToolUseRejectedMessage`). No new verb for the decline path.

## 3. Why a new frame, not an extension of `permission.response`

- **The payload is a different shape** (per-question index/freeform selections, not
  `updatedInput`/`applySuggestions`). Overloading the allow arm with a third answer-shape would
  entangle the T6 echo logic in `sanitizePermissionResponse` with an AskUserQuestion special case
  — precisely the kind of conditional that erodes a boundary invariant's legibility.
- **A distinct verb gets a clean closed-allowlist entry** in `checkStrictKeys`, a sidecar-local
  Zod schema, and accept/reject boundary tests — matching every other app-owned inbound verb
  (`permission.setMode`, `account.*`, `settings.setValue`, `run-control.*`). One verb, one schema,
  one handler, one allowlist row.
- **It still reuses the engine machinery** — the handler resolves through the identical
  `respondToPermissionRequest` the permission response uses. New wire verb, same engine path;
  no duplicated engine logic (avoids the §8.10 "duplicating engine machinery" defect class).

Rejected: extending the shared `appClientMessageSchema` (R5 — the WS server would parse a frame it
can't handle); riding `updatedInput` (T6 rejects it — §1); sending raw label strings instead of
indices (loses the C1 byte-fidelity guarantee for the model-authored labels, for no simplicity win
since the freeform text already needs a bounded-string channel).

## 4. Annotations — deliberately CUT for v1 (flagged, not silently dropped)

The tool's optional `annotations` (`{ preview?, notes? }` per question) is **not** sent. The
prototype's `onSubmit(item, map)` sends only the `{ question → answer }` map — no annotations —
so cutting it is prototype parity, not a deviation from it. Substantively: `annotations.preview`
is the *engine-minted* preview of the selected option, and the model already has every option's
`preview` in its own `AskUserQuestion` tool_use input, so echoing it back is redundant; `notes` is
a freeform-per-selection field the prototype's flow never collects. If a future surface wants
notes, it is an additive `other`-shaped field on `AskUserQuestionAnswer` with the same
freeform-bytes analysis — a follow-up, not this decision. **§0 flag: ✂️ cut(annotations —
redundant for the model + not in the prototype flow) — OPERATOR-APPROVED 2026-07-16.**

## 5. Adversarial self-review

- **A1 — can a hostile renderer author a question text or an option label?** No. Both are read
  from the sidecar's own pending-request entry by *position/index*; the wire carries only integers
  and the freeform string. The only renderer bytes that reach the model are the freeform answer.
- **A2 — is the freeform answer an escalation?** No. It is model-visible text in a read-only tool's
  result — strictly a subset of what `app.submit` already lets the renderer say to the model. No
  tool executes on it. `AskUserQuestion.isReadOnly()`/`isConcurrencySafe()` both `true`.
- **A3 — cross-tool confusion?** The tool gate (step 2) rejects the frame unless the pending
  request is an AskUserQuestion; a forged answer against a Bash gate is `bad_request`, request
  stays pending. A `permission.response` allow against an AskUserQuestion request still works but
  yields an empty answer (T6 forwards `answers`-less gated input) — a benign degrade, not a bypass.
- **A4 — TOCTOU / multi-window / abort race?** Identical to C1's: the pending entry is set once and
  its `input` is immutable between mint and resolve; if abort's mass-deny or another surface wins
  first, the answer gets `permission_not_found` (the normal S2 §2 race). The reconstructed
  `updatedInput` is a fresh object, never an alias of engine state.
- **A5 — DoS?** `answers.length` ≤ `questions.length` (engine-bounded 1–4), option indices ≤ the
  engine's option count (2–4), `other` ≤ `MAX_QUESTION_ANSWER_CHARS`, whole frame ≤
  `MAX_FRAME_BYTES` + the existing rate cap. O(questions × options).
- **A6 — Zod-strip smuggle?** `checkStrictKeys` rejects any top-level key outside
  `{type, requestId, answers}`; the sidecar-local Zod schema is `.strict()` on the inner
  `{ optionIndices, other }` objects, so an extra nested key is rejected, not stripped-and-ignored.
- **A7 — secrets?** The frame is inbound; nothing credential-shaped is read or attached. Outbound
  is unchanged (the answer surfaces only inside the normal tool_result event, `secretGuard`-scanned
  like all outbound frames).

## 6. Tests (all in `app/sidecar/sidecarServer.test.ts` unless noted)

- accept: a valid single-select index answer → engine resolves an allow whose `updatedInput.answers`
  maps question text → the engine's own option label (byte-fidelity), gated `questions` preserved;
- accept: multi-select joins selected labels with ", "; "Other…" freeform appended;
- accept: single-select "Other…" only → answer is the freeform text;
- reject: frame against a non-AskUserQuestion pending request → `bad_request`, stays pending;
- reject: `requestId` not pending → `permission_not_found`;
- reject: out-of-range / duplicate / non-integer option index → `bad_request`;
- reject: `answers.length` ≠ gated `questions.length` → `bad_request`;
- reject: single-select with two components → `bad_request`;
- reject: over-long `other` / extra nested key / non-array `answers` → `bad_request`;
- **live-path** (`sidecarServer` real controller): a real pending AskUserQuestion request answered
  through the frame drives the engine's actual `respondToPermissionRequest`, and the resolved
  decision carries the real answer — proving real data flows, not a synthetic frame
  (SECURITY-MINIMUM / CLAUDE.md §8.1).
- renderer: `askQuestionState.test.ts` (selector), `AskQuestionFlow.test.tsx` (flow + keyboard).

## 7. Carry-forwards

- Annotations (§4) — cut for v1, additive later.
- `other` rides `secretGuard`'s key-name-only posture like every value-channel string
  (SECURITY-MINIMUM "scope note") — a user who types a secret into their own answer exposes it to
  their own renderer, same as `app.submit`. Accepted, LOW.
