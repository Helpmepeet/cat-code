# Encrypted reasoning traces: implications and recommendations for Cat Code

**Date:** 2026-08-12
**Scope:** Cat Code's Claude and Codex/OpenAI reasoning paths, transcript persistence,
resume/import, remote persistence, desktop transcript projection, and diagnostics export
**Status:** revised after independent adversarial cold review; no implementation changes
**Primary source:** Alexander Panfilov et al., *Stealing Reasoning Traces from
Proprietary LLM APIs*, arXiv:2608.09867v1, 10 August 2026
([local PDF](/Users/pt/Downloads/2608.09867v1.pdf))

## 1. Executive conclusion

The paper is directly relevant to Cat Code. Cat Code is not merely adjacent to
the affected API design: its Codex adapter explicitly requests
`reasoning.encrypted_content`, converts the returned ciphertext into a
`thinking.signature`, stores the full assistant message in transcripts, and
replays the signature on later requests. Claude's native signed and redacted
thinking blocks travel through the same general message and persistence system.

The correct product lesson is not "add a reasoning decoder." The disclosed
cross-model extraction attacks were no longer reproducible after provider
mitigations, according to the paper's responsible-disclosure and reproducibility
statements. The durable lesson is that an opaque reasoning block is sensitive
active state, not harmless cache metadata. Cat Code should treat it like a
credential-bearing capability even when neither Cat Code nor the user can read
its contents.

Cat Code already has several strong controls:

- Manual login, account switch, and account deletion strip signature-bearing
  blocks.
- Provider-family changes are locked once a transcript has provider-shaped
  history.
- Local transcript files are created with mode `0600` and their directories with
  mode `0700`.
- The desktop never renders a signature or redacted payload.
- Desktop diagnostics exports explicitly exclude transcripts, caches, settings,
  vaults, raw debug logs, and raw stderr.

Those controls do not fully address the paper's threat model. An independent
adversarial review found two current paths that materially raise the priority of
client-side hygiene. The highest-value gaps are:

1. The enabled `/feedback` (`/bug`) flow uploads normalized messages, subagent
   transcripts, and the raw session JSONL after confirmation. Opaque reasoning
   can therefore leave the machine today even though `/share` is disabled.
2. Automatic Codex account failover can retry the same conversation under a
   replacement account without stripping prior-account signatures.
3. A same-provider model switch is allowed after the first turn, while replay of
   each opaque block is not checked against the model that created it.
4. Headless resume accepts an arbitrary `.jsonl` transcript and rehydrates its
   messages without quarantining or stripping opaque provider state.
5. Remote persistence sends full transcript entries, including opaque reasoning,
   and later hydrates those entries back to local JSONL.
6. The desktop secret guard rejects known secret *field names*, but it cannot
   detect secrets hidden inside a `signature` or `data` ciphertext field.
7. The repository still contains prompt text recommending `/share` of a session
   transcript, even though the external `/share` command is currently a
   disabled stub. Re-enabling that behavior without an opaque-state-safe export
   format would recreate the paper's public-trace exposure pattern.

The recommended direction is defense in depth: sanitize the active feedback
uploader first; make automatic account failover rebuild a safe request; classify
opaque reasoning as sensitive provider state; remove it from every export;
quarantine it on foreign transcript imports; design provenance-aware replay; and
make the UI disclose when a session contains unreadable retained state. Cat Code
cannot repair provider-side cryptography, but it can sharply reduce acquisition,
propagation, and accidental publication of the ciphertext.

## 2. What the paper establishes

### 2.1 Core mechanism

The affected APIs return hidden chain-of-thought as an opaque authenticated
envelope. The client returns that envelope on later requests so the provider can
continue a stateless conversation. The envelope authenticates its contents, but
the providers tested by the authors did not adequately bind it to its original
user, session, conversational position, or model.

The paper distinguishes three increasingly permissive properties:

- **Cross-session compatibility:** a block can be replayed in another session or
  at another position.
- **Cross-user compatibility:** another authenticated user can replay a captured
  block.
- **Cross-model compatibility:** another model in the same provider family can
  consume the block.

The extraction attack combines these properties with an alignment asymmetry. A
strong source model creates the encrypted reasoning; a weaker compatible model
is prompted to transcribe the decrypted content. The weaker model acts as a
"fuzzy decoder" even though the attacker never obtains the provider's key.

### 2.2 Demonstrated consequences

The main paper presents four consequences:

| Attack | Why the opaque block matters |
|---|---|
| Reasoning distillation | It exposes a much denser supervision signal than the visible answer. |
| Harmful-content recovery | Private reasoning can contain operational detail omitted from a safe visible response. |
| Secret and PII extraction | Plaintext sanitization cannot remove data hidden in an unreadable block. |
| Invisible prompt injection | A signed block can carry instructions that look like the model's own prior reasoning when replayed. |

The privacy experiment is the most immediately relevant to Cat Code. The
authors collected 6,708 public agent trajectories and decoded 315,320 reasoning
blocks. They report that 1,028 blocks, or 0.3%, contained at least one privacy
leak after two-stage labeling; 328 trajectories, or 4.9%, leaked at least one
real sensitive item. In genuine non-benchmark sessions they recovered 62 API
keys, 33 passwords, 24 access tokens, 7 private keys, and 30 personal email
addresses. Sixty-four of 704 genuine artifacts appeared only in reasoning and
not in the parsed visible trace (paper Sections 4.1 and D.1, pages 8-9 and
62-64).

A particularly important failure pattern was cleanup itself: when asked to
sanitize a conversation, a model may repeat the sensitive values in hidden
reasoning while deciding what to remove. A transcript can therefore look clean
in every user-visible field while the newly created opaque state contains the
very secrets the cleanup was meant to delete.

### 2.3 Mitigations proposed by the paper

The paper's provider-side hierarchy is sound:

1. Keep reasoning server-side and give the client only a randomized reference.
2. If stateless envelopes remain, bind them to authenticated user, session,
   predecessor, position, and model context.
3. Rotate legacy signing keys and reject old envelopes.
4. Reject cross-model replay and detect anomalous repeated signatures.
5. Train every compatible model, including cheaper models, to refuse
   transcription attacks.
6. Treat encrypted reasoning as at best semi-hidden. The model must decrypt it,
   so model-level prompt extraction remains a residual risk.

The paper also recommends stripping all opaque reasoning fields from published
trajectories and never treating an unreadable block as confidential storage
(Sections 5.4-5.6 and Appendix A, pages 10-11 and 19-20).

## 3. Evaluation of the paper

### 3.1 What is convincing

- The work demonstrates one architecture-level failure across three major API
  ecosystems rather than presenting a single-vendor jailbreak.
- The threat model is realistic for coding agents: ordinary API access, captured
  session logs, model switching, long-running resumable trajectories, and no
  provider insider access.
- The paper separates first-party extraction from third-party secret extraction
  and prompt injection, which prevents the IP-theft framing from obscuring the
  user-security impact.
- The privacy study is large enough to establish practical exposure, and the
  authors separate benchmark artifacts from genuine user-session artifacts.
- The appendices disclose the extraction and labeling procedures, discuss
  backwards compatibility, and explicitly state that the open-model
  distillation analysis is suggestive rather than causal.
- The authors responsibly disclosed the issue. By publication, their original
  extraction pipelines no longer worked, which is evidence of provider action
  and an important limit on current exploitability.

### 3.2 What remains uncertain

- There is no ground-truth plaintext for most hidden traces. Token-count
  agreement and qualitative consistency are strong evidence, but not proof of
  exact transcription.
- The attack uses stochastic generation, best-of-N selection, provider-specific
  prompts, reconciliation, and sometimes chunking. Fidelity varies materially by
  provider and source model.
- The claim that providers used a single global key is an inference from observed
  compatibility, not an inspection of proprietary cryptographic implementations.
- Public traces are a selected, non-exhaustive sample. The measured leak rate
  should not be read as a population estimate for all agent sessions.
- Privacy labels are produced by an LLM-based two-stage pipeline. The paper gives
  taxonomy and filtering counts, but the aggregate rates still inherit
  classifier error.
- Provider behavior is time-sensitive. The paper tested early-July 2026 APIs and
  states that the attacks were no longer reproducible in August 2026. Cat Code
  should therefore build invariant client-side hygiene rather than keying policy
  to a particular model matrix in Table 1.

These limits weaken claims of verbatim fidelity and prevalence, but they do not
weaken the core product conclusion: unreadable provider state can contain secrets
and can influence future model behavior, so publishing or importing it is unsafe
without explicit controls.

## 4. Cat Code's current reasoning-state path

### 4.1 Codex/OpenAI acquisition and replay

Cat Code opts into the exact artifact discussed by the paper. When reasoning is
enabled, the adapter adds `reasoning.encrypted_content` to the Responses API
include list so it can preserve cache continuity
(`src/services/api/codex-fetch-adapter.ts:1417-1425`). When a reasoning output
item completes, the adapter places `encrypted_content` into a
`signature_delta`, or synthesizes an empty `thinking` block containing only the
signature (`src/services/api/codex-fetch-adapter.ts:2183-2250`). The shared
stream handler stores that signature on the thinking content block
(`src/services/api/claude.ts:2257-2277,2371-2391`).

On the next request, every assistant `thinking` block with a non-empty signature
is translated back into a Codex `reasoning` item with
`encrypted_content: block.signature` (`src/services/api/codex-fetch-adapter.ts:1204-1224`).
Tests make this behavior intentional: OpenAI normalization preserves a trailing
opaque signature (`src/utils/providerPromptRegressions.test.ts:319-352`), and the
websocket transport tolerates local omission of provider-managed reasoning while
anchored by `previous_response_id`
(`src/services/api/codex-websocket-transport.ts:739-816`).

Cat Code does add client-side context to the transport. The conversation ID is a
stable derivation of Cat Code's session key plus account and model
(`src/services/api/codex-fetch-adapter.ts:183-213`), and the adapter uses that ID
as `prompt_cache_key` and conversation identity
(`src/services/api/codex-fetch-adapter.ts:3309-3343`). Explicit conversation-ID
overrides bypass that derivation (`src/services/api/codex-fetch-adapter.ts:196-203`),
so the isolation claim is not universal. In either case, a conversation ID does
not authenticate the provenance of an imported `thinking.signature`; the
provider still decides whether that opaque block is accepted.

Automatic Codex pool failover is a more immediate account-boundary gap. Cap,
authentication, and transient-network branches can reassign a lease and retry
after invoking only the account-change callback. Lease reassignment is explicit
in `src/services/api/codexAccountLeaseManager.ts:333-387`; the retry branches and
callback wiring are at `src/services/api/withRetry.ts:602-629,811-830,977-1001`
and `src/query.ts:730-774`. The request client then resolves credentials for the
replacement lease (`src/services/api/client.ts:341-391,469-495`), but the adapter
still translates every existing `thinking.signature` without account provenance.
Thus account A's opaque envelope can be submitted under account B. Whether a
provider accepts that replay in August 2026 is **UNVERIFIED**; historically it
matched the paper's cross-user prerequisite.

### 4.2 Claude signed and redacted thinking

Claude-native thinking follows the same transcript abstraction. Thinking and
`redacted_thinking` are provider-shaped assistant content blocks, and Cat Code's
normal request path forwards assistant content without removing those blocks
(`src/services/api/claude.ts:691-731`). Cat Code already has a general
`stripSignatureBlocks()` helper that removes thinking, redacted thinking, and
connector-text signature-bearing blocks
(`src/utils/messages.ts:5250-5289`).

That helper is correctly applied after manual login, manual account switch, and
account deletion because old signatures may belong to another credential
(`src/commands/login/login.tsx:27-38`,
`src/commands/switch-account/switch-account.ts:81-91`, and
`src/commands/delete-account/delete-account.ts:25-35`). It is not applied by the
automatic failover retry path. It also removes whole thinking blocks, including
readable content, rather than merely deleting opaque fields. It is therefore a
useful API-replay safety primitive, but not a safe general-purpose export or
import sanitizer.

### 4.3 Persistence and remote propagation

Transcript persistence copies each complete message into a `TranscriptMessage`
and appends it as JSON without content-field redaction
(`src/utils/sessionStorage.ts:1605-1678`). Local files use `0600`, while missing
parent directories are created as `0700`
(`src/utils/sessionStorage.ts:1210-1217,3374-3389`). Users can also disable
session persistence through settings, `--no-session-persistence`, or the prompt
history environment switch (`src/utils/sessionStorage.ts:1567-1581`).

Remote persistence is broader. CCR v2 sends the full transcript entry as an
internal `transcript` event, while the v1 path sends the same entry through
Session Ingress (`src/utils/sessionStorage.ts:1916-1955`). CCR v2 hydration later
writes returned event payloads directly into foreground and subagent JSONL files
(`src/utils/sessionStorage.ts:2312-2384`). In other words, an opaque reasoning
block can leave the machine, persist remotely, return later, and become a
candidate for client replay again. Whether the provider still accepts it outside
its original context is **UNVERIFIED**.

### 4.4 Enabled feedback upload

Unlike `/share`, `/feedback` (alias `/bug`) is enabled for ordinary external
users when privacy and policy gates permit (`src/commands/feedback/index.ts:6-24`).
After confirmation, it submits three transcript-bearing surfaces: normalized
foreground messages, collected subagent transcripts, and a verbatim read of the
current raw JSONL (`src/components/Feedback.tsx:137-152,189-225`). The upload is
sent to Anthropic's feedback endpoint (`src/components/Feedback.tsx:518-550`).

This is a consented product-support operation, not covert exfiltration, but its
current consent copy says only "Current session transcript" and does not explain
the raw JSONL or subagent scope (`src/components/Feedback.tsx:336-373`). The
current `redactSensitiveInfo()` logic is a narrow regex used for descriptions and
errors, not a general transcript, PII, or path sanitizer
(`src/components/Feedback.tsx:70-135`). The transcript-bearing fields are not
passed through an opaque-state sanitizer. Because OpenAI normalization
intentionally preserves trailing signatures, encrypted reasoning can be included
in `transcript`; it can also remain in the raw and subagent fields. This is the
first egress boundary Cat Code should fix.

### 4.5 Resume and import trust

Normal local resume is an expected continuity operation. The higher-risk path is
headless resume from an arbitrary file. Any argument ending in `.jsonl` is
classified as a transcript file (`src/utils/sessionUrl.ts:20-32`), and the loader
walks that file's message chain and passes the resulting messages through ordinary
deserialization (`src/utils/conversationRecovery.ts:448-493,569-620`).
Deserialization removes unresolved tool uses, orphaned thinking-only messages,
and whitespace-only assistant messages, but it does not establish who created an
opaque block or strip it as untrusted
(`src/utils/conversationRecovery.ts:157-213`).

The resume path does lock provider-family switching for any transcript containing
real conversation history (`src/utils/sessionRestore.ts:714-720`). That is useful
for consistency but does not make foreign history trustworthy. A poisoned signed
block can already name the target provider family.

### 4.6 Model switching

Cat Code's provider guard blocks only provider-family changes after the first
request. Same-provider model changes remain allowed
(`src/utils/model/providers.ts:119-132`). The replay code does not compare an
assistant message's original model with the new request model before emitting
its signature as `encrypted_content`. This is the closest current match to the
paper's cross-model attack precondition.

Provider mitigations may reject such a replay today, and Cat Code's default
transport path uses distinct conversation IDs per account and model. Current
cross-model acceptance is **UNVERIFIED**. Even so, a security boundary should not
depend on rejection by an undocumented and changing backend. At minimum, Cat
Code should remove opaque reasoning from the next provider request when the exact
model changes, unless the provider explicitly documents and enforces safe
cross-model continuation.

### 4.7 Desktop and diagnostics

The desktop treats the opaque payload correctly at the display layer. Routing
maps encrypted-only thinking and redacted-thinking rows to withheld components
(`app/renderer/src/TranscriptView.tsx:534-553`), whose implementations never
render the signature or `data` value
(`app/renderer/src/TranscriptView.tsx:3155-3181`).
Backfill validation nevertheless preserves `thinking.signature` and
`redacted_thinking.data` as legitimate content-block shapes
(`app/shared/transcriptBackfill.ts:374-415`).

The desktop secret guard walks outbound data and rejects fields with known secret
names such as `accessToken`, `apiKey`, `privateKey`, and `password`
(`app/shared/secretGuard.ts:23-60,90-98`). It cannot inspect encrypted values and
does not classify `signature` or `data` as secret fields. This is not a bug in the
scanner; it is exactly the limitation the paper identifies. Opaque reasoning
needs its own data class and policy rather than another plaintext regex.

The diagnostics bundle is already a good model for safe export. It reparses
records through closed schemas and explicitly excludes transcripts, transcript
caches, settings, vaults, account files, raw engine debug logs, renderer state,
environment, and raw stderr (`app/main/diagnosticsBundle.ts:168-211`). Any future
session-sharing feature should follow this allowlist approach rather than upload
the raw JSONL.

The external share command itself is currently a disabled, hidden stub
(`src/commands/share/index.js:1`). That limits present exposure, but it does not
remove the need for a safe export representation before sharing returns.

## 5. Threat and control matrix

| Paper risk | Cat Code exposure | Existing control | Residual gap | Priority |
|---|---|---|---|---|
| Current support-upload disclosure | Enabled `/feedback` sends normalized history, subagent transcripts, and raw JSONL. | Explicit confirmation; command privacy/policy gates; error-log redaction. | No opaque-state sanitizer and incomplete scope disclosure. | P0 |
| Cross-user secret extraction | Automatic Codex failover can resubmit prior-account signatures; opaque blocks are also stored locally/remotely. | Manual account changes strip blocks; local `0600`/`0700`; diagnostics exclude transcripts. | Current provider acceptance is **UNVERIFIED**; the client does not enforce the account boundary. | P0 |
| Cross-model extraction | Same-provider model changes can submit old signatures. | Provider-family lock; default per-model conversation IDs. | No exact source-model check; current provider acceptance is **UNVERIFIED**. | P0 hygiene |
| Invisible prompt injection | Arbitrary JSONL resume accepts assistant reasoning blocks. | Structural transcript cleanup; normal tool permissions still apply. | No foreign-origin quarantine; whether providers still accept a foreign block is **UNVERIFIED**. | P0 hygiene |
| Accidental public release | Raw transcript contains unreadable state that plaintext sanitizers cannot inspect. | `/share` is disabled; diagnostics use closed schemas. | Feedback already exports transcript state; future sharing lacks a reusable safe-export transformer. | P0 |
| Summary unfaithfulness | Default view shows provider-managed summaries. | User can choose `raw` when the provider supplies it; withheld state is visible as withheld. | Summary provenance and incompleteness are easy to over-interpret. | P1 |
| Local secret theft | Opaque blocks and visible tool data are retained in JSONL. | Private file modes; persistence can be disabled. | No separate retention or at-rest policy for opaque reasoning. | P1 |
| Decoder abuse through Cat Code | The adapter can carry arbitrary signatures from transcript state. | The published extraction pipeline stopped working after provider mitigations. | Exact mitigation and current envelope acceptance are **UNVERIFIED**; no client-side anomaly detection exists. | P1 |

Here, P0 denotes a durable confidentiality or trust-boundary defect in Cat Code,
not proof that the paper's published decoder still works. The paper establishes
historical replayability and continuing sensitivity; present cross-user and
cross-model provider acceptance was not tested in this review.

## 6. Recommended roadmap

### P0. Sanitize the enabled feedback uploader

Before `submitFeedback`, apply one safe-export transformation to every
transcript-bearing field: normalized foreground messages, raw JSONL, disk
subagent transcripts, and in-memory teammate transcripts. Remove opaque provider
state structurally. Label the result **opaque-state-safe**, not generally
secret-free: readable transcript content can still carry credentials, PII, or
internal paths. Either define and test a new structured plaintext/PII/path
redaction policy or disclose that limitation. The confirmation screen should
also disclose the actual scope, including raw session data and subagent history,
or those broader fields should be omitted.

This is the first remediation because it closes a current outbound path without
depending on whether any provider still accepts the paper's decoder prompts.

### P0. Define and enforce an opaque-provider-state boundary

Introduce one shared classifier for content that must be considered sensitive
and non-exportable:

- `thinking.signature`
- `redacted_thinking.data`
- Codex `reasoning.encrypted_content` before translation
- future provider-specific continuation blobs

The classifier should be field-structural, not regex-based. Build two explicit
transformations on top of it:

- **Safe export/import view:** remove `signature` fields, remove unreadable
  `redacted_thinking` blocks, and convert any retained readable reasoning into an
  export-only annotation or plain-text record that the normal transcript loader
  cannot deserialize as provider-authentic history.
- **Safe API replay view:** remove the entire provider-native block when an
  unsigned block would be invalid or semantically misleading.

Use the appropriate transformation in feedback/export, foreign import,
provider/model transition, remote persistence policy, and tests. Do not add these
fields to `SECRET_KEYS`: live desktop transcript delivery must still carry them
for continuity. Instead, model them as a distinct `opaqueProviderState` category
with explicit allowed destinations.

### P0. Make automatic account failover rebuild a safe request

When the Codex lease changes accounts, do not retry the already assembled
provider request unchanged. Rebuild from conversation history through the safe
API replay view so prior-account signatures cannot reach the replacement
credential. Cover cap, authentication, and transient-network failover branches,
including main-thread and subagent leases. The existing callback is useful for
state refresh, but a request-boundary test must prove that the retried payload no
longer contains account A's opaque block.

### P0. Make foreign transcript resume safe by default

Treat arbitrary `.jsonl`, ccshare-like sources, downloaded trajectories, and
remote histories without locally verifiable ownership as untrusted imports.
Before the first API call:

1. Convert history through the safe import view, then the safe API replay view.
2. Preserve visible text, readable reasoning as inert text, and tool history
   where structurally valid.
3. Show one concise notice that provider state was removed from an imported
   transcript.
4. Require a separate, explicit advanced action to preserve opaque state, and
   only offer it when Cat Code can verify the same account, session, and model.

This removes the client-side precondition for the paper's invisible injection
path without claiming that providers currently accept foreign blocks.

### P0. Create a safe transcript-export representation

Do not expose raw JSONL as the normal share format. Build an allowlisted export
that:

- removes opaque provider state completely;
- removes provider continuation identifiers and account/session transport
  metadata not needed to understand the conversation;
- keeps visible user, assistant, and tool content in an explicitly non-resumable
  schema;
- describes itself as opaque-state-safe, not generally secret-free, unless a new
  structured plaintext/PII/path redaction policy has also run;
- includes a manifest such as `opaqueProviderBlocksRemoved`, count, source
  provider families, and whether plaintext redaction was applied;
- cannot be resumed as provider-authentic history without re-import quarantine.

Use the desktop diagnostics bundle's closed-schema reparse as the architectural
model, and reuse this representation immediately for `/feedback`. Before any
`/share` implementation is re-enabled, replace the two prompt recommendations to
upload a session transcript
(`src/constants/prompts.ts:270` and `src/constants/promptStyles/gpt.ts:172`) with
language that names a sanitized support bundle.

### P1 design tranche. Bind replay to Cat Code provenance

Before translating a signature back to a provider reasoning item, require:

- same provider family;
- same exact model, unless the provider publishes a safe migration contract;
- same authenticated account reference;
- same Cat Code session or a locally authorized fork lineage;
- valid ordinal position relative to the assistant message that produced it.

Cat Code cannot modify the provider's AEAD, so this is a local policy check, not a
cryptographic substitute. Provenance metadata stored beside the transcript must
not itself be trusted when the file is foreign. A machine-owned HMAC or protected
sidecar is one possible design, but it must first define compaction, fork,
subagent, remote-hydration, account-pool, and model-migration semantics. The
paper's Appendix A warns that naive binding can break legitimate compaction and
fork workflows. On mismatch, use the safe API replay transformation; do not use
`stripSignatureBlocks()` as an export sanitizer because it deletes readable
thinking too.

### P1. Reassess remote transcript persistence

For CCR and Session Ingress, choose explicitly between two product contracts:

- **Continuity store:** opaque reasoning is retained, strongly access-controlled,
  encrypted again at rest, short-lived, never exportable, and replayable only
  into verified session/account/model lineage.
- **Portable visible transcript:** opaque reasoning is removed, accepting a cache
  and continuation-performance cost after restore.

Do not call a remote transcript "sanitized" merely because visible secrets were
removed. Cat Code should also expose retention and deletion behavior to the user.

### P1. Improve reasoning transparency without claiming fidelity

Keep the current distinction among withheld, summary, and raw provider trace.
Add two small semantic clarifications:

- label summaries as provider-generated summaries, not the model's complete
  reasoning;
- show an inspectable metadata-only session indicator when unreadable opaque
  state is retained, including block count and total bytes but never the payload.

The `/reasoning raw` option is valuable when the provider legitimately returns a
raw trace (`src/commands/reasoning/reasoning.tsx:24-60`), but Cat Code should not
attempt to manufacture raw reasoning by decoding encrypted state.

### P1. Add offline security tests

Use synthetic opaque strings only. The test matrix should cover:

- manual account switch strips all signature-bearing blocks;
- automatic cap/auth/network failover rebuilds the request without the previous
  account's opaque blocks;
- same-provider model switch strips or rejects blocks from another model;
- provider-family switch remains locked after provider-shaped history;
- arbitrary JSONL import strips opaque state before request translation;
- authorized local resume preserves same-lineage state;
- sanitized export contains neither signature values nor redacted payloads;
- `/feedback` contains no opaque values across foreground, raw JSONL, disk
  subagent, or in-memory teammate fields;
- remote hydration cannot silently upgrade an untrusted payload into trusted
  provider state;
- desktop continues to render only a withheld marker, never ciphertext.

No test needs to call a live decoder model or contain a real user trace.

### P2. Add local audit and hygiene tooling

A read-only command could inventory sessions by:

- opaque block count and byte size;
- provider/model provenance coverage;
- local versus remote persistence;
- last use and retention eligibility;
- export safety status.

It should never print signatures. A separate cleanup action can remove opaque
state from selected old sessions while preserving a backup only when the user
explicitly requests one. This would turn an invisible risk into something users
can manage without exposing the content.

## 7. What Cat Code should not build from this paper

- Do not productize the cross-model decoding jailbreak. It depends on abuse of
  provider behavior, creates a direct secret-extraction capability, and the paper
  says the disclosed pipelines are already patched.
- Do not use decoded proprietary reasoning for model training, eval-set creation,
  or prompt imitation. Apart from security and privacy concerns, the paper's
  decoded traces are not guaranteed ground truth.
- Do not add ciphertext scanning and claim it finds hidden secrets. The content
  is opaque by design.
- Do not solve the problem by hiding the block from the UI while continuing to
  publish it in raw artifacts. Cat Code already hides signatures visually; the
  missing control is at the storage and transfer boundary.
- Do not remove reasoning replay globally without measuring the cache and resume
  cost. Replay exists for real continuity and performance reasons. Apply the
  stricter policy at provenance, transition, import, and export boundaries.

## 8. Proposed implementation order and ownership

| Order | Deliverable | Likely owner files | Success criterion |
|---:|---|---|---|
| 1 | Structural classifier, safe-export transformer, and feedback integration | `src/utils/messages.ts`, `src/components/Feedback.tsx`, feedback tests | No foreground, raw JSONL, or subagent feedback field contains opaque state; consent matches scope. |
| 2 | Failover-safe request rebuild | `src/services/api/withRetry.ts`, `src/query.ts`, `src/services/api/codex-fetch-adapter.ts` | A retry under account B cannot contain account A's opaque blocks. |
| 3 | Foreign JSONL quarantine | `src/utils/sessionUrl.ts`, `src/utils/conversationRecovery.ts`, `src/cli/print.ts` | An imported signed block never reaches request translation by default. |
| 4 | Exact-model transition guard | `src/utils/model/providers.ts`, provider adapters, model-switch tests | A model change cannot submit prior-model opaque state. |
| 5 | Provenance design tranche | session/fork/compaction/remote owners | Account, session, ordinal, fork, and compaction semantics are specified before an HMAC or sidecar is implemented. |
| 6 | Remote persistence contract | `src/utils/sessionStorage.ts`, CCR/Ingress transport owners | Retention and replay policy are explicit and tested. |
| 7 | Desktop metadata-only disclosure | renderer projector/view plus settings/help text | Users can see that opaque state exists without seeing the payload. |
| 8 | Session audit command | session-storage read path and command registry | Reports counts/provenance only; never emits ciphertext. |

This ordering keeps the first tranche in the engine. A later desktop UI change
would be a separate migration session and must preserve the existing raw-event
wire contract and desktop security baseline.

## 9. Bottom line

Cat Code can use the paper most productively as a new data-classification and
trust-boundary rule:

> Opaque reasoning is confidential, behavior-bearing provider state. It is safe
> to retain and replay only inside verified continuity lineage, and it is never
> safe to publish as part of a generic transcript.

Cat Code already has several mechanical primitives needed to enforce this:
signature stripping at manual auth boundaries, provider locks, secure local file
modes, closed-schema diagnostics, and explicit transcript loaders. The immediate
missing controls are a field-aware safe-export transformer used by `/feedback`
and a failover-aware request rebuild. Provenance binding is a later design
tranche, not a small wiring change. Together these controls give Cat Code a
durable defense even as provider-side models, keys, and jailbreak behavior
change.

## 10. Verification and unresolved questions

### Verified in this review

- The 116-page PDF was text-extracted and the main paper plus Appendix A were
  visually inspected; extraction details, privacy-labeling methodology, and the
  Appendix B limitations were also reviewed.
- All Cat Code behavior claims above were checked against current source, not
  dated architecture documents.
- An independent adversarial cold review initially returned RED after finding
  the omitted feedback uploader and automatic account-failover path. This
  revision incorporates both High findings, its two Medium corrections, and its
  anchor/feasibility nits. The same reviewer returned GREEN after two follow-up
  passes, with no remaining actionable issue.
- No live model calls, account operations, reasoning extraction attempts, or
  real transcript inspections were performed.

### Unresolved

- Whether each provider's August 2026 mitigation binds user, session, model,
  position, or only blocks the published prompts is not publicly established by
  the paper. A provider rejection should therefore remain defense-in-depth, not
  Cat Code's primary control.
- The confidentiality and retention guarantees of CCR v1/v2 server storage are
  not established by the local client source reviewed here.
- Cat Code does not have enough information to verify the contents of an opaque
  block. It can only control where the block is acquired, stored, transferred,
  and replayed.

```text
VERIFICATION
- git diff --check -> clean
- git diff --no-index --check /dev/null docs/reports/2026-08-12-encrypted-reasoning-trace-security-evaluation.md -> clean; expected nonzero status because this is a new untracked file
- bun run maps:lint -> passed: 18 maps checked, 8 advisory warnings
- cited-path existence check -> every cited repository path and the source PDF present
- ASCII-hyphen check -> clean
Stale-reference sweep: not applicable; no rename, removal, or interface change
Not run: ENGINE, DESKTOP, and WEB batteries; this change adds only a Markdown research report
```
