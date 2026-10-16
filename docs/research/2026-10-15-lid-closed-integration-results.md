# Lid-closed app integration results

Updated: 2026-10-16. Status: **not end-to-end qualified; live protected-app/helper verification awaits administrator authentication**.

## What is implemented

The Electron main process owns one mode across windows, views and chats. It
captures current run identities from the real sidecars, refreshes supervision,
withdraws temporary agent context, and ends the mode when its original work
finishes. Native ownership of the fixed deadline, thermal/battery monitoring,
restoration journal and independent watcher remains separate from Electron.
The cup uses the four approved presets and the shared notice carries Stop,
End mode and sleep, scope inspection, setup and persistent recovery actions.

A new user turn has a new identity. Ongoing Agent descendants and finite Bash
work retain their originating identity; independent CreatePeer sessions, future
scheduled work, monitor commands and explicitly persistent services are excluded.
Explicitly backgrounded Bash commands must declare `work_lifetime: finite` to
count. This is a model declaration, not proof of termination: a foreground
server incorrectly classified as finite can count until the hard deadline.
Permissions and pending permission requests remain unchanged.

The temporary availability instruction is derived at query time, not saved as a
user message. A withdrawn instruction is explicitly withdrawn on later query
loops; it cannot erase text already received by a model request in flight.
Admission gates stop further enrolled query/tool scheduling after a protective
ending. Already-running tools are not promised to be killed. A fresh explicit
user turn can restore the engine's ordinary idle-sleep assertion, without
re-enrolling or unblocking the earlier protected run.

## Certificate-free replacement (2026-10-16)

The [runtime contract](../design/2026-10-15-lid-closed-runtime-contract.md)
describes the replacement: ad-hoc hard/kill Electron with an exact signed
library allowlist, a hardened native bridge, per-message XPC identity checks,
and a root-controlled app snapshot. No Apple-issued certificate, Touch ID,
security exception or sudoers entry is required. Initial setup assumes a
trusted local build. Source callers are recovery-only; completing current work
and Reopen Cat Code switches to the authorized snapshot. Rebuilds require
administrator repair/reauthorization.

Concrete authentication evidence:

- The real sealed package launches and reaches renderer ready without the
  previous Team-ID failure. The helper accepts its exact library constraint.
  A DYLD-injected marker dylib is rejected before startup by the kernel library
  constraint. No injection exception entitlement was added.
- Static checks alone proved inadequate: substituted ASAR/Info.plist JavaScript
  executed under the original native CDHash, then restoring both original files
  made a later static qualification accept the bundle. The process retained
  valid/hard/kill status. This reproduced attack is why persistent activation
  is restricted to the protected snapshot; the snapshot/RPC repair still needs
  actual root installation and negative-caller execution evidence.
- Native identity tests execute compiled, signed processes: exact constraints
  accepted; absent/broadened constraints, unprotected code, substituted payload,
  remote-debugging arguments and write-granting ACLs rejected. These fixtures
  do not establish actual Electron/XPC authorization.
- Sealed setup-asset digests reject substitutions of helper, installer and
  uninstaller before execution or administrator authorization. The final
  packaged helper's SHA256 equals its prepackage embedded source digest.
- The trial configuration admits one normal-preset lease capped at 60 seconds
  by the root controller, including adjustment and Continue. A native test
  preserves that deadline through activation delay, lid-open Continue and
  expiry. Removing retirement's terminal transition makes the new test fail at
  “retired trial Continue accepted”. No live trial has started.

Current automated checks from a clean temporary snapshot based on `dc69e1b1`,
with only this task's owned changes applied:

- Package/renderer build, stowaway scan, deep signature, native qualification,
  desktop typecheck and scoped sidecar typecheck pass. Sidecar checking ignores
  5,575 upstream engine diagnostics.
- Electron hardening smoke passes **19/19** outside the filesystem sandbox.
  The sandboxed launch aborted; it is not counted as a product regression.
- Full desktop suite: **5,954 pass, 3 skip, 1 fail**, 56,869 assertions across
  416 files. The sole `sessionRelocationRepeat.storage.test.ts:137` failure was
  reproduced on untouched `dc69e1b1` with the same expected-true/received-false
  assertion. The old archived scratch loader error was absent from this clean
  snapshot. The initial sandbox/socket-directory runs were discarded and fixed
  before this run; they are not the reported result.
- Focused native/owner/asset checks passed **9 tests / 82 assertions**. After
  installer preflight and setup-copy wording changes, the selected owner/asset,
  identity and user-copy checks passed **13 / 109**. The later partial-install
  recovery repair passed **9 / 75** owner/asset/native checks. The renderer and
  closed Reopen command checks passed **3 / 21**. Its recovery regression fails on
  the preceding owner with `unavailable` instead of `unresolved`.

Observed current UI uses an isolated **Cat Code Dev** package and a loopback SSE
model fixture. Real accounts and quota were not used. Accessibility showed the
fixture text, setup's protected-copy/reopen disclosure, Set up and Cancel. The
actual administrator command was reached, but authentication timed out before
installation. The error exposed internal shell text; that observed defect was
repaired with explicit cancelled/timed-out/failed messages. Partial setup now
observes kernel status and retains unresolved recovery if authority was
published or sleep cannot be confirmed. The revised failure copy is not yet
rechecked in the live UI.

No root snapshot, helper, launchd job or guardian was installed in this pass.
No live global sleep override or new physical lid/Sleep action occurred. Pending
qualification is actual protected-copy launch/XPC admission, substituted caller
rejection at that receiver, setup/repair/removal, real app crash/stall recovery
and active visual/input acceptance. The previous physical evidence below is
preserved and should not be repeated unless an affected behavior requires it.

## Historical signing blocker (2026-10-15)


Review found that pinning a generic Electron executable does not identify its
JavaScript application: alternate startup/debugging paths could execute different
code under the same executable identity. Persistent power authority therefore
requires the sealed app archive, startup fuses, hardened runtime, no debugger or
DYLD-injection entitlement, and library validation. The root receiving boundary
checks these before accepting an application connection, in addition to the
pinned signature, path, parent process and user identity.

The first hardened ad-hoc package passed static code-signature verification but
**failed to launch on this Mac**. `dyld[77817]` reported:

> mapping process and mapped file (non-platform) have different Team IDs

Both executable and Electron framework reported `Signature=adhoc` and
`TeamIdentifier=not set`. `security find-identity -v -p codesigning` reported
`0 valid identities found`. Apple documents that hardened library validation
requires Apple libraries or the same signing Team ID:
[Library validation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation).

No library-validation exception, debugger entitlement, SIP/Gatekeeper change,
private power entitlement, or sudoers rule was added. The ordinary local package
retains the repository's ad-hoc signing posture and launches, but the helper
refuses it. Actual UI setup displays that limitation before administrator
execution. This is a blocker for the **chosen persistent-authentication design**,
not evidence that the already-tested pmset mechanism is impossible.

That historical implementation offered `CATCODE_SIGNING_IDENTITY`. The branch
has now been removed: a certificate is not a user requirement. The current
certificate-free candidate and its remaining verification are described above;
the failure below remains evidence about the earlier chosen mechanism.

## Earlier automated and process evidence (2026-10-15)

- Engine dev build passed, including the undefined-name and map gates.
- Desktop typecheck and scoped sidecar typecheck passed. The latter reports
  5,575 ignored upstream engine diagnostics, not a clean root typecheck.
- Renderer/package build, sealed archive stowaway scan and deep signature check
  passed. Packaged headless smoke passed with no Bun on PATH and isolated state.
- Repository Electron hardening smoke: **19/19 passed**. This checks the real
  document/preload/main policy using stock Electron; it is not signed-helper
  authentication evidence.
- Focused native, owner, DOM, sidebar, preload, runtime-flag and copy checks:
  **129 tests passed, 1,153 assertions**. Native power closures are injected;
  these checks do not establish physical Sleep.
- Real controller/runtime tests: **3 passed, 15 assertions**. The third observes
  this test process's real `caffeinate` child ending on protection and returning
  only for a new user run. Removing that reset in a disposable copy makes the
  test fail at the fresh-run assertion. All test-owned assertions are cleaned up.
- Removing unreadable-journal handling in a disposable copy makes the new
  owner regression fail (`unavailable` instead of `unresolved`). The repaired
  owner also keeps red recovery through a failed administrator repair.
- Full required `bun test app/`: **5,944 pass, 3 skip, 2 fail, 1 error**. One
  failure is `sessionRelocationRepeat.storage.test.ts:137`; the same assertion
  fails on untouched HEAD in a disposable snapshot. The other reported failure
  is the loader error for missing `./accountsState.js` in the historical
  `tmp/pr22-merged-2026-09-12-evidence/.../leaseState.test.ts`. Those files were
  left unchanged. An earlier account-login failure passed in isolation and in
  the final full run.
- Actual sealed startup probe: `ELECTRON_RUN_AS_NODE=1`, `NODE_OPTIONS=--require`
  and an alternate script argument did not execute the sentinel script;
  `--inspect=127.0.0.1:18997` did not open the port. The normal app rendered.
  This limited negative probe does not prove all injection paths impossible.

## Earlier observed UI evidence (2026-10-15)

An isolated **Cat Code Dev** copy loaded its renderer from `app.asar`. No user
account or model quota was used. A loopback-only SSE fixture supplied model text;
the session controller, socket, main process, preload and renderer were real.

Observed accessibility labels and screenshots established:

1. The cup is present and exposes global scope in its accessible name. Clicking
   with no work produces “No running work to keep awake.” No lease starts.
2. A real fixture turn displays “Local integration fixture is running.” Clicking
   the cup then shows the hard-surface, Sleep, exclusive-override and recovery
   disclosures, with Set up and start and Cancel.
3. Set up and start refuses the unqualified local app before an administrator
   prompt. Cancel returns the cup to Off. Stopping the fixture turn works.
4. The shared notice remains on the Goals page with no composer.
5. A **synthetic pending recovery marker**, with the helper absent and kernel
   sleep flag false, produces one red non-dismissible warning after restart,
   on welcome and Settings. Repair and retry fails closed and explains the
   signing prerequisite. This is recovery UI evidence, not a live restoration
   failure experiment.
6. Actual screenshots found clipped notice text beside the collapsed rail and
   then the expanded rail. Both were repaired and rechecked. The final light
   screenshot shows the complete warning and Repair and retry beside the
   expanded sidebar. Dark no-work/number presentation was also observed.

Live active-state preset/wheel/steam behavior, direct Stop against a real lease,
Continue after physical lid opening through this app, narrow/split-pane visual
acceptance, full light/dark contrast measurements and reduced-motion behavior
remain unverified. DOM decisions do not substitute for these checks.

## Preserved physical evidence

No new lid, unplugging or Sleep actions were requested or inferred during this
integration pass. The earlier evidence is unchanged:

- [Battery/lid and ordinary Sleep](2026-10-14-lid-closed-physical-results.md):
  19 timestamped progress samples over 18.2564 seconds while physically closed,
  1,245,184 work bytes; user confirmed music continued for about 15 seconds.
  Restoration after reopening was observed within 0.609839 seconds. Ordinary
  Apple-menu Sleep was visibly disabled during an active lease.
- [Actual Sleep](2026-10-15-lid-closed-sleep-results.md): restoration preceded
  Software Sleep; with the Razer mouse disconnected, the user confirmed music
  stopped and Spacebar woke the Mac. Background DarkWake occurred before full
  keyboard wake, so this does not prove ten uninterrupted seconds of CPU sleep.
- [Recovery observations](2026-10-14-lid-closed-pmset-experiment.md), including
  c9a8af09: supervision loss 6.062 s; native client kill ≤5.170 s; helper crash
  ≤1.044 s; helper stall ≤5.153 s; watcher restart ≤4.035 s; expiry 60.831 s;
  stalled-lock restart ≤6.199 s. These are named native experiment results,
  **not Electron crash/stall measurements**. Reboot, concurrent loss of both
  recovery owners and actual system-command failure bounds remain unqualified.

## Authority, revocation and final state

Administrator setup pins this app executable/signature and its narrow bridge,
installs the helper and two launchd jobs, and grants only the fixed operations.
It grants no account-wide passwordless command access. An app rebuild changes
its signature and requires explicit repair/reauthorization. Removal runs the
bundled `app/native/lid-closed/uninstall.sh` with administrator authorization;
that script restores and verifies first, retaining the watcher if restoration
fails. The journal/configuration remain as evidence after successful removal.

At **2026-10-15 06:47:39 UTC**, read-only checks found `SleepDisabled=No`,
`AppleClamshellState=No`, helper and both job plists absent, and both launchd
labels absent (exit 113). No experiment guardian/collector was running. All
tracked integration test apps and the loopback fixture exited; the synthetic
marker was removed. The user's installed app was not replaced. No live global
sleep override or privileged installation occurred in this integration pass.

Evidence logs and disposable bundles are retained under `/private/tmp/cat-lid-*`.
The durable summary here separates their observations from the immutable raw
physical reports. Before a future live app test, retain the existing 60-second
experiment boundary; the normal UI minimum of 15 minutes does not authorize a
longer trial. The current restrictive app-trial configuration supplies that bound; physical participation still requires individual coordination.


## Current cleanup (2026-10-16)

After the uncompleted administrator attempt, the isolated app exited normally
and its loopback fixture exited. The earlier scratch test app had required its
runner's tracked-PID kill after a five-second shutdown wait; neither is running.
Read-only audit confirms `SleepDisabled=No`, `AppleClamshellState=No`, helper,
protected-copy directory and both launchd plists absent. Both system launchd
labels return not found (113). No experiment guardian was started or remains.
The recorded source app, sidecars, fixture servers and authorization process
PIDs are gone; registry shutdown records are clean. The installed user app was
not replaced, and no real accounts were accessed.

Final source package and desktop typecheck include the timeout/partial-setup
repair. Live receiver/active-UI qualification remains blocked on completing the
one-time macOS administrator dialog; no new approval or Touch ID requirement is
introduced for ordinary Start, adjustment or Continue.
