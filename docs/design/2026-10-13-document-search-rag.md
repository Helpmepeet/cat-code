# Document Search RAG Design

Status: Draft experiment and conditional implementation design. The agreed
product scope is document retrieval as an optional agent tool. Establish benefit
on a frozen corpus before building a production indexing subsystem. The
contracts below specify a possible implementation, not shipped capabilities.

Date: 2026-10-13

## Purpose and decision

Evaluate `SearchDocs` to help Cat Code find relevant project documentation using
natural-language questions. The hybrid candidate combines keyword and embedding
retrieval and returns cited source excerpts. The existing conversational model interprets
the results, reads surrounding material when needed, and answers or continues
the task.

The intended benefit is finding relevant documents when the question uses
different words from the source, while retaining exact matches for identifiers,
error messages, and API names. This benefit must be measured against the current
workspace-map, grep, and file-read workflow.

Separate three possible problems: failure to discover a relevant document,
failure to identify the governing decision after finding related documents, and
failure to consult documents at all. Embeddings address only part of discovery;
they do not establish authority or guarantee the agent will use the tool. If
curation or ordinary search solves the observed problem, do not build the new
retrieval subsystem.

Code search continues through the existing grep, glob, shell, and file-read
tools. There is no requirement to call `SearchDocs` before those tools. Document
retrieval does not automatically run on each prompt or inject material into the
system prompt.

## User experience

Examples of the intended division of work:

| Request | Expected approach |
| --- | --- |
| Why must a workspace move wait for persistence? | Search documents for the rationale, then read the decision and its amendments. |
| Where is `resumeCheckpoint` called? | Search current code with grep and inspect the relevant files. |
| Implement a change according to the workspace handoff decisions. | Retrieve the relevant documents, inspect current code, then implement. |
| List every occurrence of a deprecated setting. | Use exhaustive text search. Ranked retrieval cannot establish completeness. |

The tool returns evidence rather than a generated answer. The main agent owns
synthesis and cites the source files. An empty or incomplete search is reported
as such; it is not evidence that the project has no relevant documentation.

The first version uses ordinary tool-result presentation. A dedicated search
page, document upload flow, and new desktop controls are outside this scope.
The contracts below describe the experimental interface and, where labelled,
the conditional production behavior. They do not authorize building the full
subsystem before evaluation.

## Scope

The first version indexes UTF-8 `.md` files under explicitly configured document
roots within the active workspace. For Cat Code's initial evaluation, use a
frozen selection from `docs/`, including decisions, research, and reports.
Changing the selection creates a new corpus configuration revision.

Apply the existing read-permission and ignore policies as well as the document
allowlist. Default exclusions include version-control metadata, dependencies,
generated output, and the retrieval cache. Reject symlinks in the first version
to keep corpus membership unambiguous. A path extension alone does not authorize
reading a file.

Markdown code fences remain part of their containing documents, but source-code
files are not indexed. Indexing a document does not make embedded examples
authoritative descriptions of the current implementation.

The following are excluded from the first version:

- PDFs, Word files, OCR, website crawling, and connected document services.
- Source-code embeddings, dependency graphs, and cross-workspace search.
- Memory directories, raw conversation transcripts, operational logs, credentials,
  and user settings.
- Automatic memory creation, automatic prompt injection, and generated summaries
  used in place of source passages.
- A separate answer-generating model or mandatory reranker.

This respects the existing restriction on injecting raw transcripts and
diagnostics into product prompts in [CLAUDE.md](../../CLAUDE.md).

## Tool contract

Proposed name: `SearchDocs`. When enabled, expose its schema directly
(`shouldDefer: false`) in the experimental tool pool. Do not add a mandatory-use
prompt rule. Measure voluntary use separately from explicitly prompted use;
changing exposure later requires a new adoption comparison.

| Input | Meaning | Initial bound |
| --- | --- | --- |
| `query` | Nonempty natural-language question or exact terms. | 2,000 characters. |
| `scope` | Optional workspace-relative directory that narrows configured document roots. | Cannot expand the corpus or select another workspace. |
| `limit` | Maximum number of excerpts. | Default 5, range 1 to 10. |

Use a closed input schema. Reject absolute paths, traversal, unsupported fields,
and invalid bounds. Resolve workspace identity from the tool execution context,
not from a model-supplied absolute path.

A response contains:

- `status`: `ok`, `no_matches`, `unavailable`, or `error`.
- `retrieval_mode`: `hybrid` or `lexical` when retrieval ran.
- `coverage`: `complete`, `partial`, or `unknown`, defined against the requested
  configured corpus. Permission exclusions, pending updates, or skipped files
  make it partial; an unfinished inventory makes it unknown. It never measures
  semantic recall.
- `qualification`: `read_context` when an excerpt requires surrounding or
  amending text before it can be treated as governing guidance.
- A last completed inventory time when available.
- Bounded results and a concise reason when results are incomplete or unavailable.

If no eligible indexed subset can be searched, return `unavailable`, not
`no_matches`. If an eligible subset was searched successfully but found nothing,
`no_matches` retains partial or unknown coverage when applicable. A denied outer
tool call uses the normal permission rejection and does not run retrieval.

Each result contains a workspace-relative file path, document title, heading
ancestry, one-based start and end lines, exact excerpt text, document category,
and any required qualification notice with read targets. Categories follow the
repository conventions: maintained map, decision record, historical plan or
report, and other reference. Category is navigation metadata, not authority.
Include explicit document status or dates only when available from the source,
marked as source-declared and potentially stale. Filesystem modification time
is not a decision date. Keep hashes, generation IDs, and ranking diagnostics
internal to storage and evaluation rather than in agent-facing prose.

Initial output budget: 16 KiB total, reserving 4 KiB for citations and
qualification notices, with at most 3 KiB of excerpt text per result. Required
qualification notices take precedence over excerpt count or length. Drop a
result if its minimum qualification and read targets cannot fit; never remove
the warning to retain the excerpt. These are starting bounds to tune
in evaluation. Truncation must be explicit; do not produce a citation whose line
range implies omitted text was returned.

Results must not label similarity or fusion scores as confidence in a claim.
Numeric ranking scores may be retained in isolated evaluation output; the agent
does not need them to assess source authority.

Proposed model-facing description:

> Search project documentation for relevant explanations, decisions, and
> reference material. Returns source excerpts with file and line citations.
> Useful when you know the topic but not the document's wording. Use ordinary
> code search for implementation details and exact search for exhaustive matches.

Search excerpts do not satisfy any existing complete-file-read requirement for
editing. A later edit must use the normal read and mutation contracts.

## Retrieval flow

1. Validate the input, resolve the active workspace, and establish the permitted
   document scope. If scope cannot be established, return an error.
2. Open a consistent committed index generation. Inspect corpus configuration
   and indexing state; do not treat an empty unbuilt index as zero matches.
3. Run lexical retrieval and, when available, semantic retrieval over the same
   permitted document set. The query and chunks use the same embedding model
   revision and preprocessing configuration.
4. Merge candidate rankings using reciprocal rank fusion. Initially retrieve up
   to 30 candidates per method and use a fusion constant of 60. These values are
   evaluation parameters, not quality guarantees.
5. Remove duplicates and heavily overlapping excerpts. Prefer distinct relevant
   sections, but do not enforce one result per document when multiple sections
   are needed to interpret a decision.
6. Reauthorize candidate paths and verify their contents against indexed hashes.
   Exclude changed, deleted, or newly denied documents from this response. Never
   attach old excerpts to new line coordinates. Refresh eligible changed files
   within the current call's remaining indexing budget; leave unfinished work
   as a resumable checkpoint, not a detached background job.
7. Return the best surviving evidence within the result and byte budgets. If
   filtering leaves too few results, bounded overfetch may fill the remaining
   slots. Report partial coverage when refresh or filtering prevented a complete
   search of the configured corpus.

Lexical retrieval uses BM25-style ranking. Preserve identifiers and also support
searchable components of common technical names. Store original text separately
from a derived FTS column that adds camelCase and snake_case components; normalize
queries consistently. For example, `resumeCheckpoint` contributes the original
identifier and `resume checkpoint`. The derived column never supplies excerpts
or citation offsets. Semantic retrieval searches
meaning rather than requiring shared tokens. Fusion combines ranks rather than
adding scores whose scales are unrelated.

Do not add query rewriting, generated chunk descriptions, or a reranking model
until an evaluation identifies a failure they could address. The agent can
rephrase a question and call the tool again using its existing reasoning loop.

## Document parsing and citations

Parse Markdown without executing embedded content. Preserve original text and
line offsets. Headings supply navigation context, but are not sufficient
boundaries for interpreting rules.

Identify qualification groups before producing retrieval chunks. A group is an
entire numbered or bulleted item with its continuation paragraphs, or a section's
prose through the next heading of the same or higher level. Scan all paragraphs,
including bold inline text, for explicit amendment, correction, supersession,
exception, and deprecation markers. Match case-insensitively and record the
original locations. These markers are conservative navigation cues, not a
complete semantic detector.

A group with amendment markers is one interpretation unit. It may have several
embedding chunks, but every chunk links to the same complete group and every
explicit qualifier location. Never present an isolated old rule as a standalone
interpretation of that group. Return the full group if it fits; otherwise return
a discovery excerpt with `qualification: read_context`, a notice that it is not
sufficient governing guidance, and exact ranges for the complete item or section
and its qualifiers. Discontiguous excerpts carry separate citations, not a
fabricated continuous range.

If a qualifier's target is ambiguous, associate it conservatively with the
containing section or document. For decision records and historical plans or
reports, always require surrounding-context verification before treating a
retrieved fragment as governing, even when no marker was detected. Absence of a
marker is not proof of current authority. The frozen experiment uses a manually
checked qualifier map as ground truth; automatic grouping is evaluated against
that map, not assumed correct.

Start with approximately 500 tokens per embedding chunk and an 800-token maximum.
Split large groups into retrieval chunks without losing their qualification-group
links. Keep fenced code blocks whole where possible; explicitly mark oversized
splits. Title and heading context may be prepended for embedding but must remain
separate from exact excerpts. Any prepended context participates in the embedding
cache key.

Store source hash, qualification-group identity, line spans, and parser version.
Never reconstruct citations by searching for a returned sentence: duplicate
sentences make that ambiguous. Reject unstable file reads. Files over the initial
1 MiB limit are skipped and contribute to incomplete coverage.

## Old plans and current decisions

The [host request plane decision](../migration/decisions/HOST-REQUEST-PLANE.md)
contains bold inline amendments within numbered step 2, including the September
11 correction to reply-chain behavior. All of that step's paragraphs must remain
one qualification group. Heading-only detection misses this case, and a fresh
file hash cannot establish that an earlier statement still governs.

Use the document categories established by [CLAUDE.md](../../CLAUDE.md): maps
are maintained navigation, dated plans and program records describe historical
work, and decisions may contain later amendments. Preserve declared status,
explicit dates, qualifier locations, and supersession links. A header can itself
be stale; none of category, similarity, a status line, or modification time proves
current implementation or precedence.

When a source points to a replacement, return the relationship and its read
target. When a qualification group cannot fit, reserve the warning and read
locations before adding excerpt text. The main agent must inspect that context
before relying on the passage as a current rule. Conflicts remain visible rather
than being resolved by retrieval rank. Verify implementation claims in current
source.

Compare a curated corpus of currently applicable references with the broader
historical corpus. Curation uses document-level decisions made independently of
held-out questions and keeps known amendments with their parent records. Do not
rewrite away contradictions merely to improve retrieval scores.

## Experiment before production indexing

The first experiment uses prebuilt, read-only indexes over an isolated frozen
corpus. It needs no file watcher, shared writable cache, incremental indexing,
cross-process writer service, or production embedding packaging. Corpus creation
and embedding generation are explicit experiment operations with a fixed
manifest, hashes, and an authorized source selection.

Run lexical and hybrid retrieval over labelled questions before adding an agent
tool adapter. This phase needs query embeddings for hybrid retrieval but no
answer-generating model. Then expose the same immutable index through a thin
experimental `SearchDocs` adapter for the agent comparison. Neither phase writes
to live memory or indexes live transcripts.

SQLite FTS5 plus exact cosine search over stored vectors is the initial experiment
choice. An in-memory probe on 2026-10-13 verified FTS5 in local Bun 1.4.0 and that
its default tokenizer does not match `resume` inside `resumeCheckpoint`.
[statsUsageIndex.ts](../../src/utils/statsUsageIndex.ts) already uses `bun:sqlite`.
The derived token column addresses this specific lexical issue; packaged-runtime
compatibility and vector-search performance still require measurement.

## Conditional production index ownership

Build this lifecycle only after the experiment passes the retention gates below.
Choose **resumable indexing within tool calls**, with no work continuing after a
call returns. Each call owns a bounded amount of indexing and embedding work;
a cold call either finishes useful work within that budget or returns unavailable
with a checkpoint. Later calls advance it. Do not automatically loop tool calls
to finish a build. If this interaction proves inadequate, redesign ownership
explicitly before adding a background service.

Use a disposable private cache keyed by canonical active workspace, corpus
configuration revision, and index-format/model versions. Worktrees have separate
namespaces. Bind operations to the workspace captured at admission; a move
cancels or discards the former workspace operation before returning results.

One call holds a cross-process writer lock; other calls read committed snapshots
or return a bounded busy/unavailable result. Publish a complete document revision
and indexing checkpoint transactionally. On cancellation or process exit, release
the operating-system lock and discard uncommitted work. A later caller may
continue from committed checkpoints only after revalidating its own authority.
No caller inherits the previous owner's permissions.

If A owns a batch and B searches, B may read eligible committed records. If A
exits, B can acquire the released lock and start a new authorized batch on its
next attempt. Neither a lock nor A's exit transfers an in-flight job to B. Before
returning, a call stops or awaits its owned work; no detached promise may publish
later. Completed documents survive cancellation; partial documents do not.

Refresh eligible changed documents lexically first. Publish their new source
text, locations, and lexical entries transactionally; invalidate obsolete vector
associations immediately. Embeddings may catch up in a later bounded call.
Report hybrid coverage as partial while current chunks lack embeddings. Never
use vectors linked to a previous document revision as though they describe the
new text.

Reuse embeddings by a hash of the exact embedding input, pinned model revision,
dimension, and preprocessing version, not by whole-file hash. An edit re-embeds
only changed inputs. Keep this reuse inside the workspace namespace initially;
cross-worktree embedding sharing is a separate optimization. Model or parser
changes create a compatible new generation rather than mixing vector spaces.

Cache cleanup runs only during explicit local maintenance, with no active reader
or writer lease. Remove a namespace only after canonical worktree removal is
confirmed; an inaccessible directory is not proof of deletion. Provide an
explicit cache-clear operation. The experiment uses an isolated disposable cache
and does not introduce this maintenance subsystem.

## Corpus authority and coverage

Separate the **configured corpus** from the **caller-eligible subset**. Corpus
membership comes from workspace configuration and corpus-wide ignores. Caller
eligibility comes from that session's current permissions. Permission exclusions
never change global membership or delete another session's index records.

Ingestion is authorized by the specific call that performs it, for each file;
there is no privileged scanner or transferable ingestion grant. A restricted
caller may refresh files it can read. It must not mark unreadable or unenumerable
files deleted, publish a global completed inventory, or advance another caller's
unvisited inventory checkpoint. Store per-document progress and mark a full
inventory complete only when one authorized scan actually covers the configured
scope. A restricted scan may reuse that membership snapshot but not certify it
as fresh.

Only explicit corpus reconfiguration or an inventory with authority to enumerate
the affected scope may remove globally excluded or confirmed-deleted records.
Permission failures and transient I/O failures are not absence evidence. A
configuration revision produces a new namespace rather than destructively
applying one session's settings to another's cache.

`coverage: complete` means the requested configured scope has a completed,
validated inventory, all its documents are eligible for this caller, and all
supported documents are current in the active retrieval mode. A restricted
caller therefore receives `partial`, or `unknown` if inventory is unresolved,
even if every eligible file was searched. Notices state only generic causes such
as permission exclusions or pending updates; do not disclose denied filenames,
snippets, or precise hidden-file counts. Completeness never promises that every
relevant passage was found.

## Embedding execution

For the experiment and initial conditional implementation, use one explicitly
configured, operator-managed local embedding endpoint with a pinned model
revision. Cat Code is a bounded, cancellable client; it does not load a model in
every engine session, start a daemon, download weights, or own endpoint recovery.
The operator owns endpoint availability and shutdown. Choose the endpoint and
model before running hybrid evaluation and record their resource use.

Abort client requests on cancellation and discard late responses. If the endpoint
does not support cancelling its computation, document and measure that limit;
Cat Code must not claim it stopped server-side work. No late response may mutate
the index after the owning call ends.

Do not assume conversational subscriptions provide embedding access. Hosted
embeddings require a separately authorized configuration; never silently switch
to them. With a current lexical index and an unavailable embedding endpoint,
return `retrieval_mode: lexical` and a concise degradation notice. Failed hybrid
retrieval is not `no_matches`.

## Multi-file authorization contract

There are two independent gates: permission to invoke `SearchDocs`, and permission
to use each source document. Tool approval does not approve a corpus. Use the
normal tool pipeline for the outer gate, including blanket `SearchDocs` deny/ask
rules and the caller's mode. A worker that cannot obtain a required outer approval
cannot run the call.

For each candidate file, evaluate ordinary Read eligibility without prompting or
running an auto-approval classifier. Compose blanket Read rules with path rules
and the filesystem decision, preserving deny before ask before allow. A blanket
Read allow does not bypass a path-specific ask or deny; nor does a SearchDocs
allow bypass either gate. Read-level policy is an additional floor for cached
text and embeddings, even when ordinary tool-mode shortcuts might allow the
outer call.

| Current per-file decision | Ingest or rank cached content | Return excerpt |
| --- | --- | --- |
| Allow without additional approval | Permitted within configured scope. | Recheck eligibility and source snapshot before delivery. |
| Ask, including blanket Read ask | Exclude. Do not prompt for individual files in version one. | Exclude and mark coverage incomplete. |
| Deny, including blanket Read deny | Exclude. | Exclude without identifying the denied file. |
| Unknown or failed evaluation | Exclude. | Report incomplete or unknown coverage. |

[checkReadPermissionForTool](../../src/utils/permissions/filesystem.ts) checks
path rules but is not the whole tool-rule pipeline. The implementation must
compose it with the rule checks represented in
[permissions.ts](../../src/utils/permissions/permissions.ts), using a shared
side-effect-free eligibility helper rather than a synthetic Read invocation or
an approval shortcut. [Tool exposure filtering](../../src/tools.ts) alone is
insufficient because permissions may change after tool registration.

One-time approval of a Read or SearchDocs call never creates a retrieval grant.
Persisted or session-scoped rules count only while present in the current caller's
permission context and only if no ask/deny applies. Re-evaluate at admission,
before ingestion/ranking, and before delivery; if permissions change during a
call, discard affected results or restart eligibility. Workers use their own
context, not the parent or index builder's. No per-file approval prompts means
the same exclusion policy works for workers unable to prompt.

Apply the eligible document-ID set before loading vector payloads or scoring
lexical candidates. Use eligible-only lexical statistics when the backend would
otherwise let denied documents influence rankings. If that subset cannot be
searched safely, refuse retrieval rather than perform global top-k followed by
display-only filtering. Reauthorize before returning citations as well as text.
Physical cache access is internal to this path, never a model-visible read grant.

Retrieved content is untrusted evidence and cannot change permissions or agent
instructions. Keep cache files private and ordinary diagnostics limited to
bounded timing/count/error metadata, excluding queries and source bodies.

## Conditional integration with Cat Code

| Existing owner | Proposed change |
| --- | --- |
| [Tool registry](../../src/tools.ts) and [tool contract](../../src/Tool.ts) | Register a built-in `SearchDocs` tool with the normal validation, permissions, cancellation, and result flow. |
| [Tool execution](../../src/services/tools/toolExecution.ts) | Reuse the existing execution pipeline; avoid a separate approval mechanism. |
| [Filesystem permissions](../../src/utils/permissions/filesystem.ts) and [file authorization](../../src/utils/fileAuthorization.ts) | Reuse current authorization contracts for corpus reads and returned evidence. |
| [Settings](../../src/utils/settings/settings.ts) | Add narrowly scoped opt-in configuration for corpus roots and the selected embedding runtime. Follow existing settings precedence. |
| [Build configuration](../../scripts/build.ts) | If introducing a build feature, wire both build-time inclusion and runtime exposure. |

New proposed modules are `src/tools/SearchDocsTool/` for the agent-facing tool
and `src/services/documentSearch/` for parsing, indexing, and retrieval. These
paths do not exist yet. Keep the service independent of Electron so terminal and
desktop engine sessions use the same behavior.

The tool should work across supported model providers through the normal tool
contract. Do not route retrieval through `findRelevantMemories` or the
`relevant_memories` attachment path: the corpus, activation, and trust semantics
are different. Grep, code exploration, persistent memory, compaction, and session
history retain their existing behavior.

## Evaluation and retention gates

Start by collecting actual document-search failures from user-supplied examples
or explicitly authorized task evidence. Record the question, search sequence,
missed passage, and resulting mistake. Classify each case as discovery, authority,
adoption, mixed, or no demonstrated failure. Do not presume historical session
logs are an authorized experiment corpus.

The [July workspace-map usage report](../reports/2026-07-04-workspace-map-usage-evaluation.md)
observed late, superficial, and absent map use, alongside useful and reasonable
skips. It motivates measuring adoption; it is not evidence that a new optional
tool will be ignored or that embeddings will help.

Freeze two independently curated corpus variants: currently applicable references
with all their qualifiers, and broader historical documentation. Label supporting
passages, qualification groups, and governing evidence separately. Include
paraphrases, identifiers, inline corrections, stale headers, multi-section
questions, and absent answers. Record answerability for each corpus so removal
of needed evidence is not scored as a retrieval failure. Split development and
held-out questions before tuning.

First compare lexical and hybrid retrieval offline against supporting-passage
labels. Then compare the following agent conditions on each corpus with the same
model, task prompts, budgets, and isolated source snapshots:

1. Existing maps, grep, and reads.
2. Existing tools plus lexical `SearchDocs`.
3. Existing tools plus hybrid `SearchDocs`.

For each condition, use a voluntary-use arm and a separate instructed-search
arm. The latter requests document search before deciding, using normal search
in the baseline and `SearchDocs` where available. Keep all other instructions
equivalent. This arm measures retrieval when invoked; it is not the proposed
production prompt policy. Keep labels and other arms' outputs out of agent
context, and use fresh sessions for paired runs.

Measure tool availability, call rate, first-use timing relative to the first
source read and first substantive decision, and whether retrieved evidence was
used. Separate non-use, retrieval misses, missed qualifiers, and interpretation
errors. A never-called tool is an adoption outcome, not an observed retrieval
failure. A read after the decision cannot count as early decision support.

Measure supporting-evidence recall, citation accuracy, grounded correctness,
obsolete-rule reliance, search turns, latency, and context consumed. Record cold
indexing and query-embedding costs separately from warm search. Report corpus
curation effort and endpoint memory/CPU use as part of the cost. Runtime boundary
checks and retrieval/model quality are separate evidence categories.

Before held-out runs, set numeric minimum benefit and maximum overhead thresholds
using the development baseline and the user's workload. Publish those thresholds
with the frozen manifest; do not choose them after seeing held-out results.

- Retain a new lexical tool only if it beats existing search by the preregistered
  evidence-recall or search-effort margin within the correctness and cost budgets.
- Retain embeddings only if hybrid adds that measurable benefit over lexical
  retrieval, not merely over a weak baseline.
- Require no newly observed permission leaks, broken citations, or hidden
  qualification failures. Report uncertain quality differences rather than
  treating a small sample with no observed failures as proof of equivalence.
- If curation solves authority failures and retrieval adds little, improve corpus
  organization and stop. If gains appear only in instructed use, resolve adoption
  before production approval without making tool use mandatory by default.
- If evidence is inconclusive, retain the experiment artifacts and defer the
  subsystem. Neither keyword retrieval nor embeddings are presumed worth keeping.

## Conditional implementation acceptance

After a retention gate passes, demonstrate these behaviors through the real tool
pipeline before enabling production use:

- Allow/ask/deny composition, blanket rules, expired approvals, permission changes,
  and non-prompting workers enforce the same per-file eligibility floor.
- A denied or changed document cannot contribute cached excerpts or vector results.
- Numbered items with inline amendments retain their qualification group, including
  when the output budget forces a discovery-only excerpt and read targets.
- A restricted caller cannot globally delete another caller's records or publish
  complete inventory coverage.
- A exits while B searches: committed records remain readable, unfinished work
  stops, the lock releases, and a later authorized call resumes safely.
- Changed files get current lexical entries before replacement embeddings finish;
  unchanged chunk inputs reuse their vectors without reusing stale line locations.
- Worktrees and workspace moves remain isolated. Missing embeddings, incomplete
  inventory, busy indexing, no matches, and errors remain distinguishable.
- Terminal and desktop engine paths deliver bounded results for supported providers.

Use focused behavioral checks and applicable repository build checks. Follow the
active test-audit skill when authoring tests; the repository's durable reference
is the [test audit plan](../testing/2026-09-25-test-audit-plan.md). Model evaluation
requires authorization for its runtime and usage. This design revision does not
start evaluations or implement the tool.

## Delivery sequence

1. Collect and classify actual failures; freeze corpus variants, labels, and
   experimental budgets. Stop if there is no useful retrieval hypothesis.
2. Build disposable immutable indexes and compare lexical and hybrid retrieval
   offline. Choose and authorize one external local embedding endpoint for the
   experiment; add no production model lifecycle.
3. Run the thin tool-adapter experiment, including adoption and instructed-use
   arms. Apply independent retention gates to lexical retrieval and embeddings.
4. Only after benefit is established, implement the production contracts above
   for whichever retrieval mode earned retention. Validate permissions,
   qualification handling, bounded ownership, refresh, and recovery.

More formats, connected sources, reranking, automatic injection, and shared
cross-project indexes remain separate proposals requiring evidence.

## Relevant precedents

- [Roo Code indexing](https://roocodeinc.github.io/Roo-Code/features/codebase-indexing/)
  demonstrates embedding-backed retrieval exposed as a tool, including Markdown
  heading-based parsing. Cat Code adopts the tool pattern with a document-only
  corpus.
- [Cursor indexing](https://cursor.com/blog/secure-codebase-indexing) describes
  incremental updates and content-based embedding reuse. Cat Code adopts the
  freshness principle without requiring its distributed indexing architecture.
- [Continue's current guidance](https://docs.continue.dev/guides/codebase-documentation-awareness)
  integrates retrieval through agent tools and MCP sources, and distinguishes
  that approach from its deprecated context-provider workflow.
- [Anthropic's contextual retrieval explanation](https://www.anthropic.com/engineering/contextual-retrieval)
  describes combining lexical and embedding retrieval and retaining chunk context.
  Generated chunk descriptions and its reported benchmark improvements are not
  assumptions of this design.
