# Lid closed mode product specification

Date: 2026-10-13

Status: Product design draft. The agreed decisions below supersede the earlier activation panel, global countdown chip, return card, and external-power requirement. Proposed defaults are identified separately. No power-control implementation or hardware safety claim is approved by this document.

## Purpose

Let the user close a MacBook on a ventilated desk while Cat Code finishes current work within a fixed time limit. The feature controls the whole Mac's sleep behavior. Its work scope determines when the mode ends; it does not isolate other applications' power use.

The main interaction is a small coffee cup in the composer. The control communicates time and state visually; existing notice banners carry explanations and recovery actions.

## Agreed behavior

- Battery and external-power operation are both allowed. Unplugging does not end the mode.
- Activation includes all eligible work currently running in this Cat Code app instance, with no per-session selection. Its ongoing child agents and commands belong to that work.
- Idle chats, persistent servers, future scheduled runs, and new unrelated runs do not keep the mode active. A new turn in an existing chat is a new run, not an extension of the original scope.
- Duration presets are 15, 30, 60, and 120 minutes. There is no unlimited option, automatic renewal, or remembered permission to activate later.
- The mode ends when included work finishes or the deadline is reached, whichever happens first.
- Opening the lid ends the mode. Continue is available only after this end reason, while time remains, and uses the original deadline. Time keeps passing while the lid is open.
- Heat, crash, time expiry, cancellation, and other protective endings require a fresh activation. They never offer Continue or restart automatically.
- Loss of supervision must end the mode promptly. Failure to restore normal sleep behavior remains unresolved and visible until recovery succeeds; it must never appear as off.
- Existing task permissions and approval requirements do not change.

## Work scope and activation

Capture the eligible runs when activation succeeds. Switching chats or closing a view does not change that set. Descendant work created to complete an included run remains included; unrelated new work does not join. An included parent waiting for an active child still counts as working.

All composer cups represent the same mode, scope, and deadline. They must not look like independent session controls. The accessible description states that the mode covers current Cat Code work across chats.

First use completes safety disclosure and any required administrator authorization before activation. Cancelling or failing setup leaves the mode inactive. Do not display an active cup until activation is confirmed. A pending activation must remain distinguishable from a successful start without adding permanent text to the control.

**Proposed default:** when there is no eligible work, refuse activation and show “No running work to keep awake.” Do not arm the mode for a future run.

**Proposed default:** if every included run needs user input, end after a 60-second grace period. Active children continue to count. A provider or network outage may retry for up to two minutes when no other included work can progress, within the existing deadline. Pending approvals remain pending; neither ending nor Continue answers them.

## Coffee cup control

Place a 14px line icon in a 22px glyph slot in the composer's right-hand action group, before the account name. Use the slot geometry of `CacheExpiredIndicator` in [ComposerActionsBar.tsx](../../app/renderer/src/ComposerActionsBar.tsx). Coexist with the cache indicator without replacing its meaning.

Click cycles 15 → 30 → 60 → 120 → off. Selecting a duration starts the mode immediately after first-use prerequisites. Scroll and keyboard adjustment provide equivalent control. The paused and recovery states override this ordinary cycling behavior as specified below.

Hover or interaction reveals a small raised popover with an approximately 34×25px cup drawing and a numeral beside it. Four equal liquid levels and four ticks represent the presets. The selected tick uses the cup's color. The numeral uses 15px type, weight 580, tabular figures, and cream `#f1dcc3`; “min” is gray at 9.5px. The cup rises from the resting icon.

During operation, liquid drains below the selected tick, the number counts down, and restrained steam rises. After lid opening, the cup is gray and steam becomes two stationary bars indicating pause. This pause refers to keep-awake eligibility, not a guarantee that agents or commands have paused.

| State | Appearance | Primary interaction |
| --- | --- | --- |
| Off | Gray `#75757b` line cup | Select 15 minutes and activate |
| Active | Caramel `#d4a274`, draining liquid, restrained steam | Cycle duration; 120 → off ends the mode |
| Ended because lid opened | Gray `#838389`, pause bars | Continue with the original deadline |
| Protective end | Amber using `tone-warn`, empty cup | Fresh activation only after the reason is resolved |
| Sleep restoration unresolved | Empty red cup using `tone-danger` | Retry restoration; never start a new mode |

The earlier no-power plug glyph, unplug refusal shake, and power-disconnected state are removed. Battery operation is ordinary operation.

The exact active and warning colors need perceptual verification in both appearances. Use semantic theme roles for production colors, retaining the approved caramel and cream direction. Color, liquid, and animation must not be the only accessible state cues.

## Timer rules proposed for review

The preset is the total allowance from the successful activation time. The normal numeral is remaining time, rounded up to whole minutes; expiry follows actual elapsed time rather than display rounding.

An explicit adjustment while active changes the total allowance relative to that same activation time. It never resets elapsed time. For example, ten minutes into a 15-minute run, choosing 30 leaves 20 minutes. Selecting an allowance already consumed ends the mode immediately. Hover, focus, reopening the popover, and repeated rendering do not renew anything.

Briefly show the selected preset while adjusting it, then return to remaining time. The accessible description distinguishes the selected allowance from time remaining. Do not show end-clock times or “min left” in the visual control.

After lid opening, click or Enter/Space means Continue, not “next preset.” Continue retains the included runs that are still eligible and the deadline in effect when the lid opened. It cannot add unrelated work, extend time, or bypass current safety checks. Scroll and arrows do not modify a paused deadline. Once time expires or no included work remains, Continue disappears and the control returns to ordinary fresh-start behavior.

**Proposed input rule:** arrow adjustment uses Up/Down while the cup has focus, preserving the toolbar's Left/Right navigation. Wheel adjustment works only during deliberate interaction with the cup, not incidental scrolling over the composer. One deliberate step changes one preset; trackpad momentum must not race through settings or activate a dormant control accidentally. Exact wheel behavior requires interaction verification.

## Thermal and battery protection proposed for review

Use macOS thermal categories rather than claiming a universal CPU-temperature cutoff. Apple describes nominal, fair, serious, and critical states and recommends corrective action for serious and immediate resource reduction for critical conditions. See [Apple thermal guidance](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/RespondToThermalStateChanges.html).

| Condition | Proposed behavior |
| --- | --- |
| Nominal or fair thermal state | Continue within the deadline |
| Serious thermal state | End early, stop admitting further included work, restore sleep behavior, and request sleep if the lid is closed |
| Critical thermal state | Immediately reduce Cat Code-controlled work and initiate restoration and sleep; do not wait for job completion |
| Battery at or below 20 percent while discharging | Refuse activation or end an active mode |
| Required safety readings unavailable or supervision lost | Refuse activation or end promptly |
| Thermal condition returns to normal | Remain ended; require a fresh user action |

The 20-percent threshold is a proposed product reserve, not a hardware safety limit. It needs confirmation along with any reset margin needed to prevent repeated start/stop near a threshold. Restarting after a thermal stop should require nominal thermal state.

Support must be established for the actual Mac and macOS combination. Apple's thermal API documentation notes that unsupported or unknown states can appear nominal; a nominal value alone does not prove monitoring works.

The fixed timer and protections remain effective while the window is hidden or the display is off. Loss of supervision cannot leave the override active until an hours-away deadline. The exact maximum recovery interval remains a release-blocking decision that must be measurable.

These protections do not establish that the laptop is ventilated or safe inside a bag. Retain the first-use note: “Keep it on a hard surface. Never in a bag.” Apple recommends a stable, ventilated surface and unobstructed vents: [temperature guidance](https://support.apple.com/en-us/102336).

## Ending and recovery

Ending the mode and stopping a job are separate outcomes. With the lid open, normal completion, expiry, or cancellation restores ordinary sleep behavior while work may continue normally. With the lid closed, end further included scheduling, preserve available progress without an unbounded delay, remove Cat Code's sleep prevention, and request sleep. Thermal emergencies require prompt reduction of controlled work regardless of lid position.

Do not promise arbitrary processes can be safely paused, cancelled, or resumed. Important commands may have completed, failed, or been interrupted. Report only observed results. Never equate releasing a sleep override with proof that the Mac slept.

All Cat Code-owned keep-awake behavior must respect the end decision; ordinary idle-sleep prevention cannot silently defeat this mode's protective ending. Other software may affect sleep too. An unresolved conflict cannot be reported as successful system sleep.

User cancellation, explicit system sleep, quitting, and shutdown take precedence over keep-awake behavior. Restarting the app must recover unresolved restoration and must never silently reactivate an old mode.

An unresolved restoration state takes precedence over pause, completion, expiry, and other ending reasons. It remains visible across chat navigation and app restart. Closing the originating chat cannot dismiss a machine-wide problem. A retry only restores sleep behavior; it does not resume work or start another timer.

## Notices and accessibility

Keep the feature name, “Keep working with lid closed,” in the native title and accessible name. Include state, time remaining, action, and global scope in accessible descriptions as appropriate. Keyboard focus exposes the same useful content as hover. Avoid continuous screen-reader announcements of the countdown.

Use the existing [BannerStack.tsx](../../app/renderer/src/BannerStack.tsx) presentation for messages, with app-wide persistence where the condition requires it. Do not add the superseded activation panel, chrome countdown chip, or return-summary card.

Proposed copy:

| Situation | Banner and action |
| --- | --- |
| First-use safety note | “Keep it on a hard surface. Never in a bag.” |
| Already waiting for approval | “Waiting for approval.” with a link to the relevant prompt |
| Thermal stop | “Stopped because your Mac got too hot.” |
| Battery reserve reached | “Stopped to preserve battery.” |
| Monitoring unavailable | “Stopped because safety monitoring is unavailable.” |
| Restoration unresolved | “Couldn't restore normal sleep. Keep your Mac open and on your desk.” with Retry |

Messages must describe the observed state. A job finishing never hides a restoration failure. Routine completion needs no extra card or coaching. Exclude post-sleep promotion from v1.

Reduced-motion mode uses static liquid and state changes without rising, shaking, or steaming animations. Verify light and dark contrast, keyboard behavior, narrow composers, multiple panes, and non-color state recognition. Tiny visual geometry must not shrink the existing usable hit target.

## Agent behavior

Proposed temporary instruction for included work:

> The user may be unavailable during this work window. Continue within the existing instructions and permissions. Leave optional questions for the final summary. If required information or approval is missing, preserve progress and report the blocker.

The window is not a promised return time. The instruction must cease to apply when the mode ends, including lid opening, and must not remain authoritative through transcript replay or continuation. Continue can reinstate it only while the mode is active. User input remains authoritative and is handled normally. Agents cannot activate the mode, extend time, relax safeguards, or interpret this instruction as additional permission.

The integration belongs to the [prompt surfaces owner](../prompts/2026-04-30-prompt-surfaces.md). No prompt changes are part of this specification edit.

## Authorization and mechanism still open

[Current idle-sleep prevention](../../src/services/preventSleep.ts) uses `caffeinate -i`. That is not a promise of lid-closed operation. [Apple distinguishes forced sleep from idle sleep](https://developer.apple.com/library/archive/qa/qa1340/_index.html).

The supplied Insomnia report describes one-time installation of account-scoped sudoers permissions for specific power commands, followed by noninteractive `pmset` calls. It does not describe an app-exclusive privileged helper. Its recovery agent waits for an unexpired session's deadline and does not independently monitor battery or temperature; that recovery behavior is insufficient for this specification.

Before implementation approval, choose the privileged mechanism and settle:

- What administrator consent grants, whether it is app-specific or account-wide, and how to revoke it.
- Whether first-use setup avoids an administrator prompt on every activation.
- A bounded recovery guarantee after app crash, monitoring loss, and failed restoration.
- How explicit user sleep, pre-existing sleep settings, and another keep-awake app interact with ownership and restoration.
- Reliable closed-lid display/backlight handling, supported configurations, and preservation of existing screen-lock behavior.

Do not adopt application freezing, audio muting, arbitrary fan control, or unrelated power-setting changes as part of this feature.

## Acceptance requirements

Before describing the feature as ready, demonstrate:

1. Battery activation succeeds; unplugging does not end or renew the mode; the agreed reserve ends it.
2. Scope remains the original work and its descendants through chat switches, new turns, and multiple composers.
3. Preset changes obey the documented elapsed-time rule, and the deadline advances while the lid is open.
4. Only a lid-open ending offers Continue, with the same deadline and scope and fresh safety checks.
5. Serious heat, critical heat, unavailable monitoring, and a real app crash produce the required bounded protective response.
6. Restoration failure remains red and actionable across navigation and restart; Retry cannot activate the mode.
7. Required approval is never bypassed; the temporary away instruction ends with the mode.
8. On supported physical hardware, timestamped workload evidence shows actual progress while closed, and end/recovery evidence distinguishes restored settings from observed sleep.
9. Display/backlight, locking, user-requested sleep, and reopening behave as specified on that hardware.
10. The actual animations, wheel input, keyboard controls, accessible descriptions, and both color themes are inspected. Synthetic state changes alone do not establish physical safety.

## Design references and pending decisions

- [Chosen cup mock](../design-html/2026-10-13-lid-closed-cup-control.html).
- [Explored surfaces](../design-html/2026-10-13-lid-closed-mode-surfaces.html).
- [Cat Code design guide](../../DESIGN.md).

The two HTML files remain separate, untracked design-session artifacts. They were not changed by this specification and may still show the superseded external-power restriction. Their animation and wheel behavior remain unverified.

Pending product decisions are the proposed timer-adjustment rule, blocked-work grace periods, battery reserve, thermal restart condition, and final banner copy. Pending release decisions are the privilege model, measurable recovery bound, hardware support evidence, display handling, and input/color verification. The agreed battery-use and cup-design decisions are not reopened by these pending items.
