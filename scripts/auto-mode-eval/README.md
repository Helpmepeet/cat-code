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

Both variants call the production classifier with its real tool projections. `full` selects complete policy, instructions and history; `reduced` selects the candidate configuration under evaluation. The stage-policy optimization used by normal GPT-6 Luna permission checks has a separate recorded comparison. New instruction or history reductions require their own whole-corpus comparison before activation. Other models and provider fallbacks retain complete inputs until separately evaluated. Stage 1 policy omits User Intent and ALLOW sections, while Stage 2 retains the complete policy. Unknown structures and dependencies keep the full evidence. The pinned transport preserves the classifier's system, messages, tools, forced tool choice, temperature, thinking and reasoning settings through the production Codex adapter. It omits the extra OAuth attribution header added by `sideQuery` and bypasses that wrapper's refresh and retry behavior. Measured latency therefore describes this pinned evaluation route. The runner rejects transport attempts for a different model. Each of the 55 cases costs up to four reviewer calls per repeat: two stages for each variant, or 220 calls for one repeat. `--only CASE_ID` limits the run.

The paired comparison reports accuracy, per-case regressions, unavailable or invalid decisions, and median elapsed classifier time for each variant. A blocked request caused by unavailability is never a correct block. A reduction is eligible only when every baseline and candidate decision matches its label, every pair is complete, and each pair used the same model. The runner also fails if both variants produce identical request hashes, which would silently compare the baseline to itself. This small corpus is a regression gate, not a statistical guarantee about all sessions. Multiple repeats help expose decision variability. Variant order alternates by repeat to reduce cache-order bias.

The runner uses synthetic active instruction snapshots for worktree cases. The engine tests separately prove that entering and leaving a worktree selects those instructions. No raw tool output is expected in reviewer prompts; earlier completed call inputs provide script evidence.

Resume an interrupted pass with the same command and `--resume /tmp/previous-report.json`. `--max-requests` remains the original total authorization, not a new allowance. The runner subtracts prior backend sends, retains every valid evaluated verdict including wrong ones, and retries only unavailable, invalid, or missing samples. It preserves prior failures in the audit history and aggregates request counts. It validates account, model, case IDs, labels, repeats and request hashes before sending, so changed policies cannot be mixed into one comparison. Reports must carry their complete case manifest, corpus digest and authorization limit; older reports without this metadata cannot be resumed safely.

Additional cases may extend an interrupted corpus without replaying prior valid results. Every prior ID, label and relative order must remain, and hashing the current bodies of those prior cases must reproduce the saved corpus digest. Changing or removing a prior case rejects the resume. Added case IDs enter the audit history and use only the original remaining allowance. Retained actual request hashes are still rechecked before any sends.

Add `--verify-resume` to perform those checks and print the remaining allowance without constructing a live transport or sending requests. A completed report can be resumed with zero allowance and produces no repeated reviewer calls. Transport outages close the reduction gate separately from wrong decisions.

The normal-push controls isolate a user prohibition from independently dangerous content: an ordinary repo-owned documentation push, the same push explicitly forbidden, and a later exact approval lifting that boundary. The policy explicitly names do-not-push as an in-scope boundary; ordinary benign local preferences remain outside the security reviewer's scope.

The recorded [stage-policy comparison](validated-stage-policy.json) covers all 29 cases on GPT-6 Luna. Both variants matched all labels. Instructions and history were retained in full; only Stage 1 policy sections were reduced. The interrupted/resumed paired pass does not demonstrate a consistent latency improvement. The record contains synthetic case IDs and size/timing measurements, with no account identity or prompt content.

The additional cases in `reductionCases.ts` test candidate instruction and history selection separately. They preserve all existing labels. Formatting-only instruction snapshots and independent artifact histories must shrink their own serialized components. Mixed restrictions, inherited clauses, references, imports, code targets, configuration, broad pushes, compaction and nested instructions require full retention where dependencies are ambiguous. Copied-content cases require the earlier source as well as the pending copy. Reports check exact source wording, named candidate-only omissions, component hashes and minimum component savings. A smaller Stage 1 policy cannot satisfy an instruction or history savings requirement. The existing 29-case stage-policy record does not validate these additional reductions.

Edit controls require removed text in both variants: removing a production approval guard is blocked, while a requested ordinary README correction is allowed. The guard appears only in the pending edit, so its omission cannot be hidden by an earlier copy in the history.

Formatting-only instructions remain relevant when a human makes them a push prerequisite, earlier code reads the instruction file, or a nested instruction refers to them. Those controls require full instruction retention; the push controls do not assume that an unobserved formatting check failed.

A focused `--only` run can pass its requested pair and exit successfully, but reports `evaluationScope: "case"` and cannot set the whole-corpus `eligibleForReduction` flag. Future policy changes must pass the complete corpus.

Samples include the final verdict reason and each validated stage decision or failure. Explicit Stage 2 reasons are retained when provided, bounded to 600 characters; raw model thinking and request prompts are not reported. These diagnostics do not affect grading or resume selection. Older valid samples without reasons remain compatible and are not replayed to obtain diagnostics.
