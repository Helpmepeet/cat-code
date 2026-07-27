# ChatGPT Cat Code app exposes a stale tool schema and blocks repository-aware reviews

- **Date observed:** 2026-07-27
- **Component:** ChatGPT Cat Code app / Cat Code Bridge PR-review workflow
- **Severity:** high for the review workflow — every repository-aware review is blocked; no product data loss
- **Status:** open
- **Affected workflow:** `chatgpt-review-pr` bridge lane

## Summary

The ChatGPT **Cat Code** app can open the Cat Code Bridge, read an immutable review brief, and
fetch every disclosed changed-file attachment. However, ChatGPT sees only four of the six tools
required by the bridge's PR-review contract:

Available:

- `get_task_brief`
- `get_brief_attachment`
- `post_task_result`
- `report_blocked`

Missing:

- `search_repository`
- `get_repository_file`

Because the result boundary requires evidence from at least one repository file, ChatGPT correctly
refuses to post a partial or diff-only review. The run ends as `blocked` with no verdict and no
findings.

Changing the prompt from the obsolete app name **Cat Code Bridge** to the installed app name
**Cat Code** does not fix the problem. Two independent launches reached the same four-tool schema.

## User-visible symptom

The operator asks ChatGPT to review a PR or worktree through the Cat Code app. ChatGPT appears to
work for several minutes and downloads every disclosed diff, but no review is returned. The final
bridge record says the repository snapshot tools are unavailable.

From the operator's perspective, the review silently consumes time and a browser launch, then
produces neither `APPROVED` nor `REVISE`.

## Expected behavior

For a `pr-review` run, the Cat Code app should expose all six bridge tools:

1. `get_task_brief`
2. `get_brief_attachment`
3. `search_repository`
4. `get_repository_file`
5. `post_task_result`
6. `report_blocked`

ChatGPT should fetch every changed-file attachment, inspect relevant surrounding source through
the two repository tools, and post one schema-valid result. A successful run should finish in the
`received` state and persist both attachment and repository-access evidence.

## Actual behavior

Both reproduced runs:

- fetched the task brief;
- fetched all 58 disclosed Anthropic-restoration diff attachments;
- recorded zero repository accesses;
- exposed no result candidate;
- reported that `search_repository` and `get_repository_file` were missing; and
- ended in the terminal `blocked` state.

The bridge released its lineage lock after each failure. `bridgeSetup.ts status` reported
`activeLineageLocks: 0`.

## Reproduction

### Preconditions

- Cat Code Bridge installed and enabled.
- ChatGPT authenticated.
- Cat Code app connected in ChatGPT.
- A worktree or commit scope with at least one changed file.

### Steps

1. Compose a repository-aware bridge review:

   ```text
   bun launchTask.ts compose pr-review \
     --run-id <run-id> \
     --lineage-id <lineage-id> \
     --round 1 \
     --repository <repository> \
     --scope worktree \
     --task "<review task>" \
     --context "<review context>"
   ```

2. Render and confirm the complete disclosure.
3. Launch the disclosed run:

   ```text
   bun launchTask.ts launch \
     --run-id <run-id> \
     --disclosed <disclosure-digest> \
     --confirm-worktree-disclosure <disclosure-digest>
   ```

4. In the ChatGPT prompt, direct ChatGPT to use the **Cat Code** app.
5. Wait for ChatGPT to fetch the brief and all attachments.

### Observed result

ChatGPT calls `report_blocked` instead of `post_task_result` because the Cat Code app does not
offer the two repository snapshot tools.

## Reproduction evidence

### Attempt 1 — obsolete prompt label

- **Run ID:** `anthropic-cfa5257c4b40b9d861850fc3`
- **Lineage ID:** `anthropic-lineage-5554f0de666b579b62f7`
- **Prompted app:** `Cat Code Bridge`
- **Scope digest:** `e7a790c460ab5dead8d22da3ef2effa5447f5973fa7f957f2be9dcbca1c793d0`
- **Attachments fetched:** 58 of 58
- **Repository accesses:** 0
- **Result candidates:** 0
- **Terminal state:** `blocked`

Recorded reason:

> The Cat Code Bridge exposed get_task_brief/get_brief_attachment/post_task_result/report_blocked,
> but did not expose the taskContract-required search_repository and get_repository_file tools.

### Attempt 2 — canonical Cat Code app label

- **Run ID:** `anthropic-cat-code-cb7e5450642f6d8a83fd14b2`
- **Lineage ID:** `anthropic-cat-code-lineage-96275faf0549428f837d`
- **Prompted app:** `Cat Code`
- **Scope digest:** `e7a790c460ab5dead8d22da3ef2effa5447f5973fa7f957f2be9dcbca1c793d0`
- **Attachments fetched:** 58 of 58
- **Repository accesses:** 0
- **Result candidates:** 0
- **Terminal state:** `blocked`

Recorded reason:

> Required repository snapshot tools search_repository and get_repository_file are not exposed by
> the Cat Code app in this run. Only get_task_brief, get_brief_attachment, post_task_result, and
> report_blocked are available.

The identical scope digest and attachment count make the two attempts directly comparable. The
second attempt proves that selecting the canonical **Cat Code** app name does not resolve the
missing capability.

## Local implementation evidence

The current bridge implementation defines both missing tools in:

- `/Users/pt/.agents/skills/chatgpt-review-pr/bridgeServer.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/launchTask.ts`

`bridgeServer.ts` includes descriptors and handlers for:

```text
search_repository
get_repository_file
```

`launchTask.ts` requires both tools in the launch prompt, disclosure, task contract, and successful
result evidence. Its test suite passes the repository search/read path.

The installed bridge configuration was last live-validated on 2026-07-19, while the local bridge
server implementation containing the repository tools was modified on 2026-07-26. This timing is
consistent with ChatGPT retaining an older app capability schema. It is supporting evidence, not
proof of ChatGPT's internal cache behavior.

## Likely root cause

The ChatGPT Cat Code app connection appears to retain the tool schema that existed when the app was
created or connected. The local MCP server now advertises six tools, but the ChatGPT-side app
registration continues to offer the older four-tool set.

This is the leading hypothesis because:

1. the current server source contains all six descriptors and handlers;
2. the same run successfully reaches the brief and attachment endpoints;
3. ChatGPT explicitly enumerates the same four available tools in two launches;
4. both repository tools are absent together;
5. changing only the app name has no effect; and
6. the app's last live validation predates the local repository-tool implementation.

The exact caching or registration layer has not been directly observed, so the root cause remains
a hypothesis until the app is refreshed or recreated and the six-tool schema is confirmed.

## Secondary defect — launcher uses the obsolete app name

`/Users/pt/.agents/skills/chatgpt-review-pr/launchTask.ts` currently hardcodes:

```text
Use the "Cat Code Bridge" app.
```

The connected ChatGPT app is named **Cat Code**. A temporary isolated launcher copy was required
for the second reproduction to emit the requested canonical name.

This naming defect did not cause the missing tools, but it creates ambiguity and makes diagnosis
harder. The canonical app name should live in one configuration value shared by setup,
disclosure, launch prompting, tests, and documentation.

## Impact

- Repository-aware ChatGPT PR reviews cannot complete.
- Every attempt consumes one authorized browser launch and several minutes.
- No independent ChatGPT verdict or findings are produced.
- Diff-only fallback is intentionally unavailable because it would weaken the review contract.
- Local builds, tests, and human/subagent reviews are unaffected.
- The reviewed Anthropic provider changes are not implicated; the failure occurs in the external
  review transport/tool-registration layer.

## Proposed fix

### Immediate recovery

1. Refresh or reconnect the Cat Code app in ChatGPT.
2. If reconnecting does not update the tools, delete and recreate the app connection using the
   current Cat Code Bridge endpoint.
3. Confirm that ChatGPT lists all six tools before spending another review launch.
4. Run the bridge live-validation flow and require a `received` result.

The capability-bearing server URL must continue to be treated as a secret and must not be pasted
into issue text, chat transcripts, or logs.

### Product hardening

1. Change the launcher prompt to the canonical **Cat Code** app name.
2. Add a bridge/app schema version that changes whenever tools are added, removed, or altered.
3. Make setup or status clearly report when the connected ChatGPT app was validated against an
   older schema version.
4. Add a preflight that checks the ChatGPT-visible tool set before composing or transferring a
   large review.
5. Fail early with a specific “app schema refresh required” diagnostic when the six-tool
   `pr-review` capability is incomplete.
6. Preserve the existing rule that a repository-aware review may not downgrade to a diff-only
   result.

## Acceptance criteria

- [ ] The ChatGPT app is named **Cat Code** consistently in launcher output and documentation.
- [ ] ChatGPT exposes all six required tools during a live run.
- [ ] A test review fetches every disclosed changed-file attachment.
- [ ] The same review successfully calls `search_repository`.
- [ ] The same review successfully calls `get_repository_file`.
- [ ] The persisted run audit records at least one repository access.
- [ ] ChatGPT calls `post_task_result` exactly once.
- [ ] The result passes schema validation and reaches terminal state `received`.
- [ ] The result Markdown and JSON are persisted under the review lineage.
- [ ] `bridgeSetup.ts status` reports `activeLineageLocks: 0` after completion.
- [ ] Reconnecting an app with an obsolete schema either refreshes it or produces an actionable
      version-mismatch error before a browser launch.

## Workaround

There is no qualifying automated workaround while the Cat Code app exposes only four tools.
Continue using local tests and independent source reviews, or manually refresh/recreate the
ChatGPT app connection before retrying. Do not treat a diff-only ChatGPT response as an equivalent
repository-aware review.

