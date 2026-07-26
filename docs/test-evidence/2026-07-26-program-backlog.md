# Test-evidence program backlog — 2026-07-26

This is the resumable implementation ledger for the approved test-evidence
quality audit. Source anchors are re-checked immediately before each unit;
source wins over the audit where they disagree. `UNVERIFIED` means a layer is
outside the automated evidence, not that it failed.

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
| TE-0 | Record this backlog and routing line | active | Docs-only; commit explicit paths. |
| TE-1 | `writing-cat-code-tests` global skill; publish and verify; short CLAUDE routing line | active | Canonical source plus publisher hashes. |
| TE-2 | F2 two-session restore anti-Potemkin process probe | active | Credentialed answer-from-context remains `UNVERIFIED`; GUI acceptance operator-only. |
| TE-3 | F3 deferred-continuation actual durable-barrier regression | active | Real persistence + injected barrier failure. |
| TE-4 | F4 retired-GPT-model migration functional matrix and startup tripwire | active | Functional migration is the acceptance proof; wiring tripwire supplementary. |
| TE-5 | F5 classify same-process simulation and add real-process kill/survivor evidence | active | Existing `spawnConfig.probe` already proves cross-cwd isolation; do not replace it. |
| TE-6 | F7 WebSocket lifecycle proof | active | Fake socket/time plus one app-level handoff; live browser layer `UNVERIFIED`. |
| TE-7 | F1 DOM harness and interaction suite | parked — approval gate 1 | Proposed: `happy-dom` only + local mount/event helper; SSR and engine untouched. |
| TE-8 | Strengthen independent verifier mandatory-spawn condition | parked — approval gate 2 | Proposed: remove hard-off `tengu_hive_evidence` conjunct; preserve `VERIFICATION_AGENT` compilation gate. |
| TE-9 | F6 source-string guard classification | deferred as audit disposition | Keep fast tripwire; owner is next preload/boundary session. No false executable-proof claim. |
| TE-10 | P2 shadow evaluation corpus, A/B/C runs, recommendation | blocked on TE-1 completion | Produce measured gate proposal; do not enforce until operator threshold decision. |
| TE-11 | P2 hook/repository enforcement | parked — approval gate 3 | Requires TE-10 measurements and threshold decision. |

## Required gates

1. Approve the DOM dependency and narrow harness shape before TE-7.
2. Approve the live verifier-condition code change before TE-8.
3. Review TE-10 shadow-evaluation numbers and approve thresholds before TE-11.
4. Ask before any `DONE.md` write, push, or history rewrite. None is authorized
   by this program.

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
