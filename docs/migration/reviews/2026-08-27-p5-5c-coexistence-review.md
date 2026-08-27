# P5-5c TUI and desktop coexistence cold review

Date: 2026-08-27

## Verdict

YELLOW: the confirmed headless defects were fixed and focused verification is green. Packaged-app/TUI visible acceptance remains operator-driven, and the full desktop aggregate suite cannot be run hermetically without changing provider-dependent test behavior.

## Contract conformance

The implementation preserves the locked desktop topology and security boundary. Terminal and desktop processes may share one Cat Code state home while owning different engine transcripts. Same-transcript ownership is enforced in the engine rather than through either process registry. Desktop sidecars remain under desktop-supervisor authority and do not register in the terminal PID registry.

Shared engine startup now owns versioned migrations for both products. Shared settings, global config, account vaults, secure storage, memory, derived caches, transcripts, and cleanup use their applicable cross-process ownership and atomic-publication disciplines. No preload method, inbound frame, renderer authority, protocol shape, directional limit, or secret boundary was widened.

## Validated findings

| ID | Severity | Finding | Verdict |
|---|---|---|---|
| F1 | High | A compromised prior transcript guard could reject release before the newly acquired guard became active, permanently wedging future lease transitions. | Confirmed and fixed. The new guard is pinned first; prior release is best-effort and cannot discard it. |
| F2 | High | Current-session transcript appends did not continuously assert lease health, so a former owner could keep writing after stale-lock reclamation. | Confirmed and fixed. Current-session queues, metadata, direct appenders, and durable writes assert active guard health. |
| F3 | High | Desktop same-transcript refusal exited as generic fatal code 1, so the host marked the row crashed and kept offering a restore that failed repeatedly. | Confirmed and fixed. Busy resume has a distinct retryable exit classification and remains restorable. |
| F4 | High | A transcript release error between socket cleanup and `process.exit` converted clean exit or park into a crash. | Confirmed and fixed. Requested clean/park exit proceeds after bounded best-effort release logging. |
| F5 | High | A deferred-continuation worker colliding with foreground transcript ownership terminally failed the job as unknown. | Confirmed and fixed. The job returns to pending with the same attempt identity and a bounded retry time. |
| F6 | High | A failed fresh secure-storage read could be interpreted as an empty store and publish deletion of untouched credentials. | Confirmed and fixed. Fresh reads distinguish present, missing, and unavailable; unavailable state fails closed without publication. |
| F7 | High (forwarded) | Timer-driven lock-compromise flags were required in synchronous Claude/Codex vault write spans. | Rejected. The spans contain no yield, so proper-lockfile's timer callback cannot run during them. The proposed check would always be false. |
| F8 | Medium | Team-memory local state was read before network fetch and outside the mutation lock; checksum state advanced before local publication. | Confirmed and fixed. The local snapshot is read under lock after fetch, and checksum state advances only after successful publication. |
| F9 | Medium | Atomic temp files inside the team-memory tree could be observed by the recursive sync scan. | Confirmed and fixed. Team-memory publications stage temporary files outside the synced subtree. |
| F10 | Medium | Memory lock contention expired before a normal multi-turn extraction holder completed. | Confirmed and fixed with bounded asynchronous waiting that covers the established holder duration. |
| F11 | Medium | Global config writes failed closed after a short wait but callers could not observe whether persistence occurred. | Confirmed and fixed. The contention window was extended, failure emits a bounded event, and the writer returns the actual write result. |
| F12 | Medium | Crash-stale engine migration locks and the legacy upstream migration lock could block startup before their stale windows elapsed. | Confirmed and fixed. Immediate contenders wait through bounded stale reclamation; completed upstream migration skips before lock acquisition and rechecks under lock. |
| F13 | Medium | Valid JSON with a non-object global config bypassed the established `ConfigParseError` path. | Confirmed and fixed. Migration reads now preserve typed config failure handling. |
| F14 | Medium | Quarantine persistence could throw again from inside its failure handler and escape a timer launched with `void`. | Confirmed and fixed. Timer callbacks are rejection-safe and per-account persistence failures are isolated. |
| F15 | Medium | TUI `--continue`, `--resume`, and the interactive resume picker handled transcript-busy errors generically or silently. | Confirmed and fixed in the authorized print and picker surfaces. |
| F16 | Medium | Cleanup leased fresh transcripts before checking age, and timestamped `.cast` names never passed UUID validation. | Confirmed and fixed. Age is checked before leasing and restated under lease; recording names extract their UUID prefix. |
| F17 | Low | Cleanup minted permanent zero-byte lease targets for every swept session. | Confirmed and fixed. Unowned lease targets are removed after guard release, with bounded target recreation for contenders. |

## Rejected or narrowed review claims

- Corrupt credential profiles remain fail-closed. They are not overwritten or moved aside merely to make future saves pass.
- An `ERELEASED` result after uncertain ownership is not reported as successful durability. Release itself is idempotent, while ambiguous publication remains failure.
- Thirty-day image-cache retention is a defensible safety change from the prior purge-on-sight behavior, not a parity defect.
- Backend locking and retention changes are not prototype-parity section-zero flags.
- The test-only migration-version branch limits test discrimination but does not weaken production fresh reads.
- The secure-storage mutable-base mechanism was real but latent. It was still corrected with per-return-object WeakMap snapshots.

## Residuals

1. A process suspended by the operating system inside a synchronous vault critical section can outlive the stale window and resume after another process has reclaimed the lock. Timer-driven compromise flags cannot detect this no-yield case. Closing it would require synchronous lock-directory identity verification immediately before publication. Severity: Medium.
2. `writeFileAtomicDurableIfContentMatches` is compare-then-rename, not a general filesystem compare-and-swap. Engine team-memory writers are serialized by `.memory-mutation`; an uncoordinated external writer in the final comparison-to-rename window remains outside that guarantee. Severity: Low.
3. The current build does not expose `cat-code ps`: `BG_SESSIONS` is absent from `scripts/build.ts` and `src/cli/bg.ts` is absent. The durable decision is separation from the terminal PID registry, not a live command guarantee.
4. Packaged-app/TUI visible coexistence is unverified. Exact isolated operator steps were provided in the implementation session report.
5. The full app test suite is not hermetic under the required synthetic state. A temporary credential-free home produced 4,129 pass / 13 environment-dependent failures. A temporary Bedrock route produced 4,124 pass / 18 failures because provider-selection assertions changed. No fake or live credential retry was attempted.

## Verification

- Transcript lease compromise and cleanup probe: 4 pass, 36 assertions.
- Deferred continuation probe and runner tests: 21 pass, 134 assertions.
- Host and sidecar resume tests: 69 pass, 402 assertions.
- Session storage tests: 35 pass, 90 assertions.
- Print/deferred resume tests: 16 pass, 29 assertions.
- Secure-storage and config result tests: 5 pass, 17 assertions.
- Engine and upstream migration probes: 5 pass, 30 assertions.
- Codex refresh tests: 27 pass, 118 assertions.
- Codex account-pool tests: 84 pass, 242 assertions.
- Claude account-pool tests: 18 pass, 52 assertions.
- Atomic/team-memory probes: 7 pass, 26 assertions.
- Desktop strict typecheck: passed.
- Scoped sidecar typecheck: passed, 5,568 upstream diagnostics ignored.
- `build:dev:full`: passed; `cli-dev` printed `2.1.87-dev.20260827.t111946.shab9a666c5`.
- `git diff --check`: passed before review bookkeeping.
