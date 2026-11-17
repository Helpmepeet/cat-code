# Auto-mode evidence evaluation

This synthetic corpus checks the reviewer's evidence and labels decisions before any input reduction is enabled. It complements engine delivery tests in `src/app-runtime/`; its messages are canonical snapshots, so it does not prove the engine produced those snapshots.

The corpus includes scoped yes replies, refusals and later approval, non-human approval claims, production boundaries, earlier script contents, compaction, active worktree instruction snapshots, and nested restrictions. Labels explain the intended decision independently of the classifier. Review labels when policy changes.

Run from the repository root:

```sh
bun --feature=TRANSCRIPT_CLASSIFIER --feature=AUTO_MODE_UPSTREAM_PORT scripts/auto-mode-eval/run.ts --offline --out /tmp/auto-mode-evidence.json
bun test scripts/auto-mode-eval/grade.test.ts
```

Offline execution supplies canned transport responses solely to capture both stage requests. It checks that named evidence reaches each request and raw tool output stays excluded. It measures neither decision accuracy nor reviewer latency. Reports contain component sizes, evidence names and hashes, without prompt text. Offline configuration uses an isolated temporary directory.

Real model runs spend quota and require the user's explicit authorization naming the model, account, and approximate call count. Read available account aliases and status without refreshing or probing:

```sh
bun scripts/auto-mode-eval/accounts.ts
```

The live runner requires an exact account alias or unambiguous ID prefix, the approved identity prefix, and an explicit request limit. It binds that account's existing credentials to the production Codex adapter. It refuses expired or near-expiry credentials and unbound legacy profiles. It never logs in, refreshes credentials, retries the SDK call, or switches accounts. A process-local fetch guard permits only the Codex responses endpoint for the approved account and counts backend fetch initiations separately from SDK attempts. The runner stops at the first unavailable or invalid review and preserves bounded original transport errors, with credential strings redacted. A backend fetch initiation does not prove that the provider received or charged the request.

The production credential boundary acquires a lock under `~/.cat-code/codex-credential-lifecycle/` before sending. A restricted shell sandbox may deny that bookkeeping write or network access before the reviewer runs. Use the platform's approved execution path for an authorized live evaluation; do not bypass the credential boundary or refresh tokens to work around it. SDK attempts alone do not establish backend sends or quota use.

```sh
bun --feature=TRANSCRIPT_CLASSIFIER --feature=AUTO_MODE_UPSTREAM_PORT scripts/auto-mode-eval/run.ts --live --model MODEL --account ACCOUNT_ALIAS --account-id-prefix APPROVED_ID_PREFIX --max-requests AUTHORIZED_LIMIT --repeats 3 --out /tmp/auto-mode-decisions.json
```

Both variants call the production classifier with its real tool projections. `full` uses the normal payload; `reduced` selects an evaluation-only candidate. The product defaults to `full`. The pinned transport preserves the classifier's system, messages, tools, forced tool choice, temperature, thinking and reasoning settings through the production Codex adapter. It omits the extra OAuth attribution header added by `sideQuery` and bypasses that wrapper's refresh and retry behavior. Measured latency therefore describes this pinned evaluation route. The runner rejects transport attempts for a different model. Each of the 26 cases costs up to four reviewer calls per repeat: two stages for each variant, or 104 calls for one repeat. `--only CASE_ID` limits the run.

The paired comparison reports accuracy, per-case regressions, unavailable or invalid decisions, and median elapsed classifier time for each variant. A blocked request caused by unavailability is never a correct block. A reduction is eligible only when every baseline and candidate decision matches its label, every pair is complete, and each pair used the same model. The runner also fails if both variants produce identical request hashes, which would silently compare the baseline to itself. This small corpus is a regression gate, not a statistical guarantee about all sessions. Multiple repeats help expose decision variability. Variant order alternates by repeat to reduce cache-order bias.

The runner uses synthetic active instruction snapshots for worktree cases. The engine tests separately prove that entering and leaving a worktree selects those instructions. No raw tool output is expected in reviewer prompts; earlier completed call inputs provide script evidence.
