# Document Search RAG Design

Status: Draft implementation design. The agreed scope is document retrieval as
an optional agent tool. Storage, embedding runtime, and tuning values below are
proposals, not implemented capabilities.

Date: 2026-10-13

## Purpose and decision

Add `SearchDocs` to help Cat Code find relevant project documentation using
natural-language questions. The tool combines keyword and embedding retrieval
and returns cited source excerpts. The existing conversational model interprets
the results, reads surrounding material when needed, and answers or continues
the task.

The intended benefit is finding relevant documents when the question uses
different words from the source, while retaining exact matches for identifiers,
error messages, and API names. This benefit must be measured against the current
workspace-map, grep, and file-read workflow.

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

Proposed name: `SearchDocs`.

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
- `coverage`: `complete`, `partial`, or `unknown`, referring only to the
  configured corpus inventory, never semantic recall.
- An index generation identifier and a last completed scan time when available.
- Bounded results and a concise reason when results are incomplete or unavailable.

Each result contains a workspace-relative file path, document title, heading
ancestry, one-based start and end lines, exact excerpt text, source content hash,
and whether it matched lexical retrieval, semantic retrieval, or both. Include
explicit document status or dates only when available from the source, marked
as source-declared metadata. Filesystem modification time is separate metadata.

Initial output budget: 16 KiB total, with at most 3 KiB of excerpt text per
result, including room for citation metadata. These are starting bounds to tune
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
   Exclude changed, deleted, or newly denied documents. Never attach old excerpts
   to new line coordinates. Schedule eligible changed files for refresh.
7. Return the best surviving evidence within the result and byte budgets. If
   filtering leaves too few results, bounded overfetch may fill the remaining
   slots. Report partial coverage when refresh or filtering prevented a complete
   search of the configured corpus.

Lexical retrieval uses BM25-style ranking. Preserve identifiers and also support
searchable components of common technical names. Semantic retrieval searches
meaning rather than requiring shared tokens. Fusion combines ranks rather than
adding scores whose scales are unrelated.

Do not add query rewriting, generated chunk descriptions, or a reranking model
until an evaluation identifies a failure they could address. The agent can
rephrase a question and call the tool again using its existing reasoning loop.

## Document parsing and citations

Parse Markdown without executing embedded content. Split by headings, preserving
document title and heading ancestry. Split oversized sections at paragraph or
list boundaries where possible; keep a small overlap only for sections that
must be divided. Treat fenced code blocks as units when they fit; mark any split
of an oversized block explicitly.

Start with a target of approximately 500 tokens per chunk and an 800-token
maximum. Preserve original text and line offsets. Title and heading context may
be prepended to embedding input, but must remain distinguishable from the exact
source excerpt.

Store each chunk's source hash, section identity, original line span, and parser
version. Do not derive citations by searching for a returned sentence after
retrieval; repeated text would make that ambiguous.

Documents larger than the initial 1 MiB file limit are skipped with a bounded
coverage notice. This is a resource limit, not a claim that larger documents are
irrelevant. Source text and line spans must come from one stable file snapshot.

## Old plans and current decisions

Document freshness is the main project-specific correctness risk. A dated plan
may describe an abandoned approach. A decision may contain later amendments in
the same file. For example, the
[host request plane decision](../migration/decisions/HOST-REQUEST-PLANE.md)
contains multiple amendments that qualify earlier statements.

Keep source-declared status, explicit dates, heading ancestry, and direct
supersession links when present. Preserve those qualifiers in returned context.
When a document explicitly links to a replacement, return that relationship and
let the agent inspect the replacement. Do not infer that a document is current
merely because its filename or modification time is newer.

If a matched section belongs to a decision with identifiable amendment sections,
include their headings and locations in a bounded note. This is a navigation
aid, not an automatic determination of which statement governs. Missing or
ambiguous status remains unknown.

For current implementation claims, read current source. For design rationale,
distinguish accepted decisions, proposals, and historical observations. When
sources disagree, cite the disagreement rather than silently selecting the
highest-ranked passage.

## Index storage and lifecycle

Propose a local, disposable index under Cat Code's private cache, separate from
tracked repository files and authoritative memory. Key it by the canonical
active workspace directory and corpus configuration. Different worktrees get
different index namespaces even when they share a Git repository.

The initial storage candidate is SQLite with FTS5 for lexical retrieval and
stored embedding vectors scanned by cosine similarity for this bounded corpus.
Confirm FTS5 support and packaging compatibility with Cat Code's Bun runtime
before adopting it. This avoids introducing a separate vector database service
for the first version. Measure scan latency and memory use before deciding
whether approximate nearest-neighbor indexing is needed.

Persist document metadata, exact chunks, lexical index data, vectors, content
hashes, embedding model identity and dimension, parser version, configuration
revision, and index progress. A document update publishes its chunks and search
records transactionally. Old chunks disappear with the replacement; failed
updates never publish a half-written document.

On the first explicit search after enablement, start a bounded build if no index
exists. Return `unavailable` with indexing state if no usable generation is ready.
Subsequent calls may search the completed subset with `coverage: partial`.
Never block a conversation on an unbounded first build.

Before subsequent searches, run a bounded incremental inventory check. Reuse
unchanged content, refresh modified files, and remove deleted or newly excluded
documents. Candidate hash verification remains mandatory even if metadata
suggests a file is unchanged. A partially completed inventory cannot claim
complete coverage. File watchers are a later optimization, not a first-version
correctness dependency.

Multiple sessions may read the same workspace index. Use cross-process locking
to admit one writer and transactional snapshots for readers. Another session
building an index is a recoverable indexing state, not a reason to start a
duplicate embedding job. Bind every operation to the workspace identity captured
at admission; a workspace move must not reuse the former workspace's results.

Model, vector-dimension, or chunking changes require a new index generation.
Never compare vectors from incompatible models. Failed rebuilds leave any
compatible committed generation readable; otherwise report unavailability.
Cache deletion is safe because source documents remain authoritative.

## Embedding runtime and permissions

The first implementation should target one explicitly configured local embedding
runtime and one pinned model revision. Select the runtime and model through a
small quality and packaging spike; this design does not authorize installing
dependencies, downloading model weights, or using paid services.

Do not assume existing conversational subscriptions provide an embedding API.
Hosted embedding support, if added later, requires a separate configuration and
explicit authorization for transmitting document text and queries. Never switch
from local to hosted embeddings automatically.

If the configured embedding runtime is unavailable and a valid lexical index
exists, return lexical results with `retrieval_mode: lexical`. This is degraded
operation, not successful hybrid retrieval. An indexing or provider failure
must not be reported as `no_matches`.

Authorize ingestion and result delivery separately. Cached text is still private
source content: the index must not bypass current file-read denies or expand a
worker's accessible scope. Apply scope constraints before lexical or vector
ranking as well as before returning text. If the initial implementation cannot
safely search an authorized subset, refuse the search rather than querying a
broader corpus and filtering only the displayed results.

Treat retrieved prose and code fences as untrusted evidence, not instructions
that can change permissions, tool policy, or agent behavior. Return them through
ordinary tool results, preserving source attribution.

Tool cancellation stops query work and query-initiated embedding work, releases
leases safely, and publishes no partial document transaction. Bound embedding
concurrency, file reads, result size, and execution time. Index-cache files use
private permissions; diagnostic logs record timings, counts, and error categories
without document bodies or user queries.

## Integration with Cat Code

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

## Evaluation and acceptance

Freeze a representative document corpus and build a small set of questions with
human-checked supporting passages. Include paraphrases, exact identifiers,
questions requiring multiple sections, old plans with amendments, and questions
whose answer is absent. Keep tuning questions separate from held-out questions.

Compare three conditions with the same model, task prompts, and corpus snapshot:

1. Existing workspace-map, grep, and file-read workflow.
2. That workflow plus lexical document retrieval.
3. That workflow plus hybrid document retrieval.

Measure retrieval of supporting evidence within the top results, citation
accuracy, grounded answer correctness, incorrect reliance on obsolete material,
search turns, latency, and context consumption. Report initial indexing time,
incremental refresh cost, disk use, and embedding-runtime resource use separately
from warm query latency. Do not infer total savings from shorter excerpts alone.

Before running the held-out comparison, record the tolerated latency and resource
budgets and the minimum improvement needed to justify retaining embeddings.
Retain hybrid retrieval only if it adds useful evidence or reduces search effort
without materially worsening answer correctness or stale-source handling. A small
pilot establishes feasibility, not a general productivity claim.

Implementation acceptance must also demonstrate:

- Citations resolve to the exact bytes and line ranges returned.
- A changed, deleted, excluded, or newly denied file cannot leak an old excerpt.
- Indexes stay isolated across worktrees and workspace moves.
- Concurrent sessions do not corrupt the index or duplicate the same build.
- Cancellation and process interruption leave a recoverable committed index.
- Missing embeddings, partial indexing, no matches, and errors remain distinct.
- Both terminal and desktop engine paths deliver bounded results through the
  real tool pipeline for supported providers.

Use focused behavioral checks for those boundaries and the applicable repository
build checks. Any test implementation follows the repository's test-audit skill.
Run model-based evaluation only with authorization for the chosen runtime and
usage.

## Delivery sequence

1. Establish the corpus, questions, embedding runtime candidate, and baseline.
   Confirm storage compatibility and record resource budgets.
2. Implement the tool contract, Markdown chunks, lexical retrieval, citations,
   permission enforcement, and index lifecycle.
3. Add embeddings and rank fusion using the same corpus and lifecycle. Exercise
   degraded behavior before evaluating retrieval quality.
4. Run the held-out comparison, choose whether to retain hybrid retrieval, and
   document the measured result. Keep the feature opt-in during evaluation.

Later extensions require a demonstrated need: more document formats, external
sources, a reranker, automatic retrieval, or an index shared across projects.
They are not prerequisites for completing this design.

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
