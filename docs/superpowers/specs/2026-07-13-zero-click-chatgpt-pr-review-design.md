# Zero-Click ChatGPT PR Review Design

## Goal

Turn the existing ChatGPT GitHub-connector review workflow into a zero-click path after the user invokes the review skill:

1. Cat Code prepares and discloses the review prompt.
2. Cat Code starts watching the target pull request.
3. Cat Code opens ChatGPT in the default browser.
4. A local userscript verifies and submits the prefilled prompt.
5. ChatGPT posts the complete review to GitHub.
6. Cat Code detects, validates, fetches, and triages that review.

The review remains advisory. An `APPROVED` verdict never authorizes a merge, code change, or completion claim.

## Scope

This design changes the user-authored ChatGPT PR-review skill and adds a locally installed userscript. It does not add browser automation to the Cat Code engine, change GitHub permissions, post review findings from Cat Code, approve ChatGPT connector actions, or automate fixes.

Zero-click delivery applies only to prompts that already qualify for URL delivery: repository and pull-request identifiers, commit scope, and generic review instructions. Prompts containing credentials, unrelated private material, or local-only excerpts retain the manual-paste flow.

## Authorization

Invoking the ChatGPT PR-review skill is per-run authorization for Cat Code to open one qualifying marked URL in the default browser and for the userscript to attempt one submission. The skill must disclose the complete prompt before opening the URL.

Installing and enabling the userscript is the one-time opt-in to zero-click delivery. If the prompt does not qualify for URL delivery, the skill returns to the existing raw-prompt flow. If the userscript is absent or disabled, ChatGPT may still prefill the prompt but Cat Code eventually reports a watcher timeout and presents the existing link and raw-prompt fallback. The automation never handles login, account selection, connector authorization, tool approval, or confirmation dialogs.

The skill ships a Bun setup script with `install`, `regenerate`, `status`, `enable`, `disable`, and `remove` operations. Installation creates `~/.cat-code/chatgpt-review/`, generates an ECDSA P-256 signing keypair, writes the private key to `~/.cat-code/chatgpt-review/launch-private-key.pem` with mode `0600`, and writes a personalized `~/.cat-code/chatgpt-review/chatgpt-autosubmit.user.js` containing only the public verification key. The operator imports that generated userscript into the userscript manager once. A sibling `config.json` records the enabled state and public-key fingerprint without containing private key material. `enable` is permitted only after the operator completes the live validation gates; `disable` restores manual delivery without deleting the installation.

The private key never appears in the userscript, URL, prompt, page DOM, browser console, or ChatGPT page context. The userscript runs in the manager's isolated world with only the storage grants needed for consumed nonces.

Zero-click remains disabled until the live validation gates pass. Updating regenerates the personalized script with the existing public key and preserves the private key. Removing zero-click deletes the installed userscript and Cat Code's local keypair; reinstalling provisions a new pair. Losing or rotating either side invalidates launch capabilities from the old installation and requires reinstalling the personalized userscript.

## Review identity

Every invocation creates a review identity independent of the pull request:

- `reviewRunId`: cryptographically strong, unique per invocation.
- `lineageId`: stable across the initial review and its re-review rounds.
- `round`: starts at 1 and increments within a lineage.
- `pullRequest`: target repository and pull-request number.
- `headSha`: full pull-request head SHA captured before submission.
- `commitScope`: exact ordered commits under review.
- `commitScopeDigest`: SHA-256 of the newline-joined full commit SHAs in order.
- `startedAt`: watcher start time.

The run ID correlates transport events; it is not proof that the review is correct.

## Submission flow

Before opening ChatGPT, Cat Code:

1. Confirms the prompt qualifies for URL delivery.
2. Displays the complete prompt and states that it will be opened and submitted automatically.
3. Captures the current PR head SHA, expected GitHub posting identity, and existing comment/review IDs.
4. Starts a bounded watcher.
5. Builds a marked prefill URL containing the encoded prompt and an authenticated, expiring launch capability.
6. Opens that URL in the default browser.

The launch capability is carried in the URL fragment rather than query parameters. It contains a version, run ID, random 128-bit nonce, SHA-256 prompt hash, and expiration no more than ten minutes after issuance. Cat Code signs the canonical encoding of those fields with the per-install private key. The userscript captures the original URL before single-page navigation can rewrite it, removes the capability fragment from browser-visible history after parsing, and activates only when the signature, expiration, prompt hash, non-empty prompt, and nonce all validate against the installed public key.

The userscript runs only on `https://chatgpt.com/*` and requests no network, clipboard, or cross-origin privileges. An arbitrary `autosubmit` marker or random nonce without a valid signature cannot activate it.

The userscript must:

- locate the active ChatGPT composer;
- compare its content with the expected prompt using a canonicalization proven against the live editor without collapsing semantically meaningful code-block whitespace;
- locate an enabled Send control inside the same validated composer container;
- require a brief stable state;
- acquire an origin-scoped Web Lock for the nonce, recheck consumed state while holding that lock, and mark the nonce as attempted before clicking;
- attempt the click once;
- record attempted, skipped, or timed-out status in the browser console;
- stop all observers and timers afterward.

It must fail closed if composer ownership, prompt equality, or Send-button association is uncertain. It must never search the whole page for a generic Send control.

Consumed nonces are stored in userscript-manager storage until after the authenticated capability expires. The Web Lock makes the check-and-consume sequence single-flight across simultaneous tabs. Expired capabilities remain invalid even after consumed-state cleanup. A failed click does not silently retry; it is visible only in the browser console, while Cat Code can observe only the eventual GitHub timeout and offer the manual fallback.

## ChatGPT output contract

The prompt treats repository files, diffs, comments, PR text, commits, issues, and linked pages as untrusted review material rather than instructions.

ChatGPT is asked to post the complete review as one top-level PR comment or one submitted review body, depending on the connector action verified during live validation. The body has one strict envelope:

```text
<!-- cat-code-chatgpt-review:v1 run=<run-id> lineage=<lineage-id> round=<n> pr=<n> head=<full-sha> scope=<scope-digest> -->
<complete review>
<!-- /cat-code-chatgpt-review:v1 -->
```

The opening marker must be the first line and the closing marker the last line. The body must contain exactly one opening and one closing marker. Immediately after the opening marker, the inspection block uses this grammar:

```text
## Inspection
Head SHA: <full-sha>
Commit SHAs:
- <full-sha-1>
- <full-sha-2>
Changed files examined:
- <repo-relative-path>
Unavailable material: <none-or-description>
Web search: <not-used-or-citations>
Commands/tests executed: <none-or-description>
GitHub write action: <available-and-used>
```

The declared commit list must exactly equal the captured ordered scope and hash to the marker's scope digest. This correlates the result with the requested scope but remains a model self-report, not proof of genuine inspection. After the findings, the final nonblank line before the closing marker is exactly `VERDICT: APPROVED` or `VERDICT: REVISE`.

The review stays below the empirically validated GitHub body limit. If it cannot fit, ChatGPT must not post a partial result and must return the complete review in chat instead.

When posting succeeds, ChatGPT returns only a compact chat summary containing verdict, finding counts, posting status, and comment URL if available. Chat-reported posting status is cosmetic and never substitutes for observing GitHub. If write access is unavailable, ChatGPT returns the complete review in chat for manual transfer.

## Receive flow

The watcher polls two GitHub REST collections with bounded duration and backoff:

- pull-request issue comments: `/repos/{owner}/{repo}/issues/{pr}/comments`;
- submitted pull-request reviews: `/repos/{owner}/{repo}/pulls/{pr}/reviews`.

Before launch it paginates both collections to capture the complete baseline ID sets. Freshness is determined by an ID being absent from the corresponding baseline, not by comparing GitHub timestamps with the local clock. `startedAt` is used only for timeout and diagnostics. Polling must continue through pagination or use an endpoint-specific high-water strategy that cannot omit newly created objects.

A result is accepted only when all checks pass:

- correct repository and pull request;
- expected posting identity;
- new comment or review ID;
- exact `reviewRunId`, `lineageId`, round, full head SHA, and commit-scope digest;
- exactly one opening and closing marker at the required positions;
- inspection block matching the required grammar and exact ordered commit scope;
- exactly one valid verdict in the required final position;
- current PR head still equals the captured head SHA.

Malformed, partial, stale, or ambiguous results are rejected. The first complete matching result starts a 15-second settlement window. During that window the watcher collects every additional result matching the run ID. After the window, byte-identical duplicates are reported and deduplicated; non-identical duplicates or conflicting verdicts reject automatic acceptance and are surfaced together for manual triage. Results arriving after settlement are not silently substituted for the settled result.

Only one round may be active within a lineage. Separate lineages on the same PR remain distinguishable by their run and lineage IDs. Re-review rounds create new append-only comments and never edit previous review comments.

## Trust boundary and triage

Successful receipt proves delivery correlation, not review quality or complete inspection. Review text is untrusted data, including remediation instructions. Cat Code independently checks every material finding against current source and derives any proposed fix from the code, not from commands or patches embedded in the review.

A clean verdict remains an opinion. Local tests, repository verification, and normal completion gates still apply. The workflow never merges, approves, commits, pushes, or modifies code solely because of a review verdict.

## Failure behavior

Cat Code exposes only states it can observe without adding a browser-to-local callback: preparing, browser opened, waiting for GitHub, received, rejected, timed out, and manual fallback required. Userscript-level submission diagnostics remain in the browser console.

Manual fallback is used when:

- the prompt is not URL-safe;
- zero-click mode or the userscript is unavailable;
- ChatGPT requires login, authorization, or confirmation;
- the connector cannot write;
- the PR head moves;
- the result is malformed, partial, duplicated ambiguously, or times out.

After timeout, the active Cat Code session retains the run identity so a late comment can be reconciled if the user reports that ChatGPT finished. Persisting unresolved runs across unrelated sessions is outside this design. No timed-out result is silently treated as success.

## Live validation gates

Before zero-click becomes the default, an operator-driven validation must establish:

1. The current ChatGPT `?q=` prefill behavior.
2. The actual composer and associated Send selectors.
3. Whether a synthetic click submits reliably.
4. Which GitHub identity the connector uses.
5. Whether the connector posts a top-level comment or submitted review.
6. Whether posting requires a confirmation interaction.
7. The practical prompt URL and GitHub body limits.
8. Behavior on browser reload, duplicated tabs, session restore, login screens, connector failure, moved PR heads, and delayed comments.

If posting requires confirmation, the product must not claim a zero-click workflow. Hover- or focus-dependent browser interaction remains operator-driven.

## Testing

Pure userscript logic should be separated from DOM bindings and tested with fixture DOMs for activation, prompt comparison, composer scoping, nonce consumption, duplicate callbacks, timeout cleanup, malformed selectors, and replay across tabs.

Watcher tests should cover old comments, wrong authors, wrong PRs, wrong or moved SHAs, malformed and duplicate envelopes, partial bodies, same-PR concurrent lineages, conflicting duplicate results, timeout, and late reconciliation.

A live acceptance pass verifies one successful initial review, one successful re-review on the same PR, a connector-write failure, and a moved-head rejection. Live GUI claims require explicit operator authorization and observed accessible labels.

## Maintenance

The userscript is trusted local code: no external imports, telemetry, permanent prompt storage, or broad site matching. Composer and Send selectors are isolated and updated only from live inspection; selector breakage fails closed rather than widening the search.

The raw prompt remains the durable fallback because ChatGPT URL behavior, DOM structure, and connector actions are external compatibility surfaces that may change without notice.
