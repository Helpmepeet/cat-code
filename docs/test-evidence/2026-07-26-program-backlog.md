# Test-evidence program backlog — 2026-07-26

This is the resumable implementation ledger for the approved test-evidence
quality audit. Source anchors are re-checked immediately before each unit;
source wins over the audit where they disagree. `UNVERIFIED` means a layer is
outside the automated evidence, not that it failed.

**PROGRAM CLOSED 2026-07-27.** Operator decision: keep the lightweight
`writing-cat-code-tests` skill (rewritten; republished, canonical hash
`d8652b01…`) and the landed TE-2..TE-5 fixes; all parked/active units are
closed as not pursued. Approval gates 1–3 are dissolved. Nothing here is
resumable backlog. Disposition addendum:
`docs/reports/2026-07-26-test-evidence-quality-audit.md`.

## Operating decisions

- Desktop units remain on `migration`, update their dedicated STATUS row/note,
  and receive the complete desktop battery. GUI acceptance is operator work.
- New high-risk tests state the production entry point, exact pre-fix failure,
  highest proof layer, pairwise/adversarial coverage, and higher unverified
  layers in their test evidence record.
- The global `writing-cat-code-tests` skill is canonical at
  `~/.agents/skills/writing-cat-code-tests`; publication, never manual mirror
  edits, owns Claude Code and Cat Code copies.
- P2 enforcement is sequenced after the skill and the shadow evaluation.

## Units

| Unit | Finding / scope | State | Outcome / evidence |
|---|---|---|---|
| TE-0 | Record this backlog and routing line | done | Docs-only; committed explicit paths. |
| TE-1 | `writing-cat-code-tests` global skill; publish and verify; short CLAUDE routing line | done | Canonical source validated; publisher hash `db767ac…a8321` verified for Claude Code and Cat Code mirrors. |
| TE-2 | F2 two-session restore anti-Potemkin process probe | done | `9bb3a3c`; distinct realistic-tail transcripts, stable ids/fresh PIDs/no marker crossover; old leaf predicate mutation red. Credentialed answer-from-context and GUI remain `UNVERIFIED`. Primary desktop battery: 1426/0, tsc clean, wrapper 5546 ignored, hardening 19/19. |
| TE-3 | F3 deferred-continuation actual durable-barrier regression | done | `bda89ee`; materialized persisted JSONL and injected `FileHandle.sync` at the actual flush barrier; removing the await turned red. Process crash/restart, DOM, GUI, credentialed-live `UNVERIFIED`. |
| TE-4 | F4 retired-GPT-model migration functional matrix and startup tripwire | done | `381585e`; user model/list/overrides/runtime override/idempotence matrix plus honestly classified source tripwire; early-return mutation 3 red functional failures. Live settings-file/process and higher layers `UNVERIFIED`. |
| TE-5 | F5 classify same-process simulation and add real-process kill/survivor evidence | done | `2cb6217`; existing real cross-cwd probe retained; concurrent sidecars/SIGKILL-one/survivor-ping is process evidence; mutation killing B went red. GUI/credentialed-live `UNVERIFIED`. |
| TE-6 | F7 WebSocket lifecycle proof | closed — not pursued (2026-07-27) | Needed the declined happy-dom harness; backoff-helper coverage stands; hook/socket lifecycle remains `UNVERIFIED`. |
| TE-7 | F1 DOM harness and interaction suite | closed — not pursued (2026-07-27) | `happy-dom` dependency declined; renderer interaction stays SSR-plus-live-GUI verified. |
| TE-8 | Strengthen independent verifier mandatory-spawn condition | closed — not pursued (2026-07-27) | Hard-off flag conditions stand; verifier remains opt-in. |
| TE-9 | F6 source-string guard classification | deferred as audit disposition | Keep fast tripwire; owner is next preload/boundary session. No false executable-proof claim. |
| TE-10 | P2 shadow evaluation corpus, A/B/C runs, recommendation | closed (2026-07-27) | Read-only ten-case pilot recorded below; the larger measured shadow program is not pursued. |
| TE-11 | P2 hook/repository enforcement | closed — not pursued (2026-07-27) | No Stop/SubagentStop hook, repository evidence check, or thresholds. |

## Required gates

Gates 1–3 dissolved 2026-07-27: the units they guarded (TE-7, TE-8, TE-11)
were closed as not pursued.

1. ~~Approve the DOM dependency and narrow harness shape before TE-7.~~
2. ~~Approve the live verifier-condition code change before TE-8.~~
3. ~~Review TE-10 shadow-evaluation numbers and approve thresholds before
   TE-11.~~
4. Ask before any `DONE.md` write, push, or history rewrite. None is authorized
   by this program.

## TE-10 shadow-evaluation pilot

This is a read-only ten-case planning pilot, not implementation evidence. It
used the audit's historical escapes: startup tools, forged ping, impossible
web fixture, null trust, pending-to-error, slash catalog, restore tail, split
active-index, settings contention, and account refresh contention.

| Condition | Entry points | Exact defect/mutation plan | Composition | Honest `UNVERIFIED` | Result |
|---|---:|---:|---:|---:|---|
| A — current workflow | 10/10 | 10/10 proposed (7/10 currently exact) | 10/10 proposed | 10/10 | 2 DOM cases correctly blocked; estimates only. |
| B — skill + evidence block | 10/10 | 10/10 proposed | 10/10 proposed | 10/10 | Complete plans, but no commands/mutations executed in this read-only pilot. |
| C — test author + verifier | 10/10 source-valid | 0/10 verifier-confirmed | 8/10 seams available | 0/10 durable records | **0 PASS / 10 PARTIAL**: chat-only author handoff left the verifier no durable artifact to inspect. |

The pilot therefore does **not** produce a defensible mutation-kill percentage
or wall-time overhead for enforcement thresholds. Its actionable result is
that a durable `TEST EVIDENCE` record is mandatory before invoking the
independent verifier. Re-run a ten-task implementation shadow with committed
or dated-artifact handoffs after the DOM gate; then bring mutation-kill,
false-block, elapsed-time, conflict, and rework measurements to gate 3.

## Unit evidence template

```text
TEST EVIDENCE
- Claim:
- Exact pre-fix failure:
- Production entry point:
- Test path:
- Proof layer:
- Red/mutation evidence:
- Pairwise/adversarial cases:
- UNVERIFIED:
- Commands and outcomes:
```
