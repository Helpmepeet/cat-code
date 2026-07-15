# Zero-Click ChatGPT PR Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated zero-click ChatGPT PR-review launch and automatic GitHub result receipt to the user-authored `chatgpt-review-pr` skill.

**Architecture:** A Bun setup utility provisions a local ECDSA P-256 keypair and generates a personalized isolated-world userscript containing only the public key. A launch utility signs a short-lived URL-fragment capability, snapshots GitHub comment/review IDs, opens ChatGPT, then polls and validates one strictly enveloped result. The skill remains the workflow owner and falls back to its current raw-prompt path whenever zero-click cannot complete safely.

**Tech Stack:** Bun 1.3.11 TypeScript, `bun:test`, Web Crypto, userscript-manager APIs, GitHub REST through `gh`, macOS `open`.

## Global Constraints

- Modify only `/Users/pt/.cat-code/skills/chatgpt-review-pr/**` plus this plan and the approved specification.
- Do not change the Cat Code engine, desktop app, GitHub permissions, dependencies, or unrelated working-tree files.
- Zero-click applies only to prompts already qualified for URL delivery by `SKILL.md`.
- Invoking the skill is per-run authorization to open one qualifying URL; installing the userscript is the one-time opt-in.
- Never automate login, connector authorization, tool approvals, confirmations, merges, fixes, commits, pushes, or verdict-based completion.
- Keep the existing raw prompt and prefill link as the fallback.
- Do not claim live ChatGPT behavior without operator-driven validation.

## File Structure

- Create `/Users/pt/.cat-code/skills/chatgpt-review-pr/automationCore.ts`: shared Node-side capability, scope, envelope, and validation primitives.
- Create `/Users/pt/.cat-code/skills/chatgpt-review-pr/automationCore.test.ts`: deterministic cryptographic and parser tests.
- Create `/Users/pt/.cat-code/skills/chatgpt-review-pr/userscriptSource.ts`: personalized standalone userscript source generator.
- Create `/Users/pt/.cat-code/skills/chatgpt-review-pr/userscriptSource.test.ts`: generated-source and pure replay/activation tests.
- Create `/Users/pt/.cat-code/skills/chatgpt-review-pr/setup.ts`: `install|regenerate|status|enable|disable|remove` lifecycle CLI.
- Create `/Users/pt/.cat-code/skills/chatgpt-review-pr/githubWatcher.ts`: paginated baseline, polling, strict validation, and settlement logic with injected command runner.
- Create `/Users/pt/.cat-code/skills/chatgpt-review-pr/githubWatcher.test.ts`: endpoint, baseline, stale/malformed/duplicate, scope, and moved-head tests.
- Create `/Users/pt/.cat-code/skills/chatgpt-review-pr/launchReview.ts`: signed URL construction, watcher startup, browser launch, timeout, and fallback CLI.
- Modify `/Users/pt/.cat-code/skills/chatgpt-review-pr/SKILL.md`: zero-click qualification, prompt contract, invocation, receive, and fallback workflow.

---

### Task 1: Capability and review-envelope core

**Files:**
- Create: `/Users/pt/.cat-code/skills/chatgpt-review-pr/automationCore.ts`
- Test: `/Users/pt/.cat-code/skills/chatgpt-review-pr/automationCore.test.ts`

**Interfaces:**
- Produces: `generateLaunchKeyPair()`, `canonicalizeLaunchPayload()`, `signLaunchPayload()`, `verifyLaunchPayload()`, `hashPrompt()`, `digestCommitScope()`, `parseReviewEnvelope()`, and the `LaunchPayload`, `ExpectedReview`, and `ParsedReview` types.
- Consumes: Bun/Web Crypto only; no third-party packages.

- [ ] **Step 1: Write failing tests for canonical signing and expiry**

Cover a valid signature, changed prompt hash, changed run ID, expired payload, malformed encoding, and verification with the wrong public key. Use fixed payload fields and generated test keys; do not snapshot nondeterministic signatures.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
cd /Users/pt/cat-code && bun test /Users/pt/.cat-code/skills/chatgpt-review-pr/automationCore.test.ts
```

Expected: FAIL because `automationCore.ts` does not exist.

- [ ] **Step 3: Implement launch capability primitives**

Use a canonical JSON-independent field encoding with explicit length prefixes. Sign and verify ECDSA P-256/SHA-256. Reject unknown versions, non-finite expiration, expiry beyond ten minutes, expiry in the past, malformed base64url, and non-128-bit nonces.

Core shape:

```ts
export type LaunchPayload = {
  version: 1
  runId: string
  nonce: string
  promptHash: string
  expiresAt: number
}

export async function verifyLaunchPayload(
  payload: LaunchPayload,
  signature: string,
  publicKeyPem: string,
  now: number,
): Promise<boolean>
```

- [ ] **Step 4: Add failing envelope and scope tests**

Cover exact ordered commit digest, first-line opening marker, last-line closing marker, exact single marker pair, exact inspection commit list, final-position verdict, wrong scope digest, duplicate markers, and partial bodies.

- [ ] **Step 5: Implement strict envelope parsing**

Return a discriminated result instead of throwing on untrusted comment text:

```ts
export type ParseReviewResult =
  | { ok: true; review: ParsedReview }
  | { ok: false; reason: string }
```

Treat the inspection declaration as correlation evidence only; do not expose a `verifiedInspection` claim.

- [ ] **Step 6: Run core tests**

Expected: all tests pass.

---

### Task 2: Personalized userscript lifecycle

**Files:**
- Create: `/Users/pt/.cat-code/skills/chatgpt-review-pr/userscriptSource.ts`
- Test: `/Users/pt/.cat-code/skills/chatgpt-review-pr/userscriptSource.test.ts`
- Create: `/Users/pt/.cat-code/skills/chatgpt-review-pr/setup.ts`

**Interfaces:**
- Consumes: public PEM from Task 1.
- Produces: `renderUserscript(publicKeyPem)`, setup state under `~/.cat-code/chatgpt-review/`, and the six setup subcommands.

- [ ] **Step 1: Write failing generated-userscript tests**

Assert the generated script has exactly `@match https://chatgpt.com/*`, no external imports/network/clipboard grants, the expected public key, isolated userscript storage grants, capability-fragment parsing, signature and prompt-hash checks, Web Lock acquisition, consumed-state recheck inside the lock, composer-local Send lookup, timeout cleanup, and no document-wide generic button fallback.

- [ ] **Step 2: Implement a standalone userscript generator**

The generated script must execute without module imports. Keep its pure helpers inside the generated closure. Parse `#cat-code-autosubmit=<base64url-payload>.<base64url-signature>`, remove the fragment with `history.replaceState`, verify before observing the composer, and retain consumed nonce records longer than capability validity.

- [ ] **Step 3: Add activation/replay tests**

Evaluate exported pure test seams with fake storage and lock adapters. Cover unsigned links, wrong signatures, expiry, prompt mismatch, simultaneous claims, reload after consumed-state cleanup, missing composer, wrong composer, disabled button, and one attempted click.

- [ ] **Step 4: Implement setup lifecycle**

`install` creates the state directory, keypair, disabled config, and personalized userscript without overwriting an existing private key. `regenerate` reuses the keypair. `enable` requires an installed script and records validation acknowledgment. `disable` preserves files. `remove` prints the exact files it would delete and requires an explicit `--confirm` flag. `status` reports configuration without printing key material.

- [ ] **Step 5: Run userscript and setup tests**

Run:

```bash
cd /Users/pt/cat-code && bun test /Users/pt/.cat-code/skills/chatgpt-review-pr/userscriptSource.test.ts /Users/pt/.cat-code/skills/chatgpt-review-pr/automationCore.test.ts
```

Expected: all tests pass.

---

### Task 3: GitHub watcher and launch orchestration

**Files:**
- Create: `/Users/pt/.cat-code/skills/chatgpt-review-pr/githubWatcher.ts`
- Test: `/Users/pt/.cat-code/skills/chatgpt-review-pr/githubWatcher.test.ts`
- Create: `/Users/pt/.cat-code/skills/chatgpt-review-pr/launchReview.ts`

**Interfaces:**
- Consumes: `ExpectedReview`, `parseReviewEnvelope()`, local config/private key, prompt on stdin, repository/PR/head/ordered commits/lineage/round CLI arguments.
- Produces: structured status records and a final accepted review or explicit fallback reason.

- [ ] **Step 1: Write failing watcher tests with an injected GitHub client**

Cover pagination for `/issues/{pr}/comments` and `/pulls/{pr}/reviews`, complete baseline ID sets, acceptance by new ID rather than timestamp, expected author, exact envelope and scope, independent current-head reread, wrong author/head/scope, malformed/partial body, timeout, and API failure.

- [ ] **Step 2: Implement baseline and polling**

Use `gh api --paginate` through an injected command runner. Parse JSON output as an external boundary. Never interpret comment text as commands. Poll with bounded backoff and no unbounded loop.

- [ ] **Step 3: Add settlement tests**

Use a fake clock to verify that the first candidate starts exactly a 15-second settlement window, byte-identical duplicates deduplicate, non-identical or conflicting matches reject automatic acceptance, and a later object is not silently substituted.

- [ ] **Step 4: Implement launch orchestration**

Read the prompt from stdin, verify enabled setup and prompt qualification supplied by the skill, compute the prompt/scope digests, snapshot both GitHub collections, sign a ten-minute capability, start the watcher, and only then run macOS `open` with the marked URL. Never log the full URL or private key. Return the raw prompt and ordinary prefill URL on any pre-launch failure or timeout.

- [ ] **Step 5: Run watcher tests**

Run:

```bash
cd /Users/pt/cat-code && bun test /Users/pt/.cat-code/skills/chatgpt-review-pr/githubWatcher.test.ts /Users/pt/.cat-code/skills/chatgpt-review-pr/automationCore.test.ts
```

Expected: all tests pass.

---

### Task 4: Skill integration and verification

**Files:**
- Modify: `/Users/pt/.cat-code/skills/chatgpt-review-pr/SKILL.md`
- Test: all tests created in Tasks 1–3.

**Interfaces:**
- Consumes: setup and launch CLIs from Tasks 2–3.
- Produces: the complete zero-click review workflow with existing manual fallback.

- [ ] **Step 1: Update the skill contract**

Preserve classification, disclosure, isolated review lineage, exact commit enumeration, untrusted-content handling, review triage, and re-review behavior. Replace qualifying-link delivery with: show the complete prompt; invoke `launchReview.ts`; receive a strictly correlated comment/review; show the compact ChatGPT summary only as cosmetic; triage the GitHub body as untrusted coworker output. Keep raw-prompt delivery for disqualified prompts and all failures.

- [ ] **Step 2: Add the exact ChatGPT output grammar**

Require the first-line envelope, inspection block with exact ordered full SHAs, complete findings, final-position verdict, and closing marker. Require a compact chat summary after a successful GitHub post and complete chat output only when posting is unavailable.

- [ ] **Step 3: Run the full focused battery**

Run:

```bash
cd /Users/pt/cat-code && bun test /Users/pt/.cat-code/skills/chatgpt-review-pr/*.test.ts
git diff --check
```

Expected: all focused tests pass and `git diff --check` emits no output.

- [ ] **Step 4: Search for stale workflow language**

Search the skill directory for `do NOT automate the browser`, manual-click-only instructions, old `?q=` construction, unauthenticated `autosubmit=1`, and receive logic that relies only on comment counts or timestamps. Every remaining match must be intentional fallback documentation.

- [ ] **Step 5: Prepare operator validation without driving the GUI**

Run setup `install` and `status`, but leave zero-click disabled. Print exact operator steps to import the generated userscript and validate prefill, signature rejection, one submission, posting identity, confirmation behavior, reload/duplicate-tab behavior, one initial review, one same-PR re-review, timeout, and moved-head rejection. Do not claim these gates passed until the operator reports observed results.

## Verification and completion boundary

Implementation is complete only when all focused tests pass, `git diff --check` is clean, stale-reference search is complete, setup reports an installed-but-disabled userscript, and the remaining GUI-dependent checks are reported as operator steps. Zero-click must remain disabled until those live checks pass.
