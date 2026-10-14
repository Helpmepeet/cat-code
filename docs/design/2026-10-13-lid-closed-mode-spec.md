# Lid closed mode product specification

Date: 2026-10-13

Status: Implementation in progress. Revised on 2026-10-14 with approved pmset tradeoffs. The historical [feasibility investigation](../research/2026-10-14-lid-closed-power-feasibility.md) records why the previous requirements blocked that route; it is not a universal impossibility finding. The cup remains numerals-only and explanations use the existing notice surface. Physical qualification is required before describing the feature as ready.

## Approved power-control tradeoffs

- Ordinary macOS Sleep may be blocked while the global override is active. Setup discloses this explicitly. The globally visible **End mode and sleep** action first restores the setting and confirms restoration, then requests sleep. A sleep request is not evidence that the Mac slept.
- This mode requires exclusive use of the global sleep override. Refuse activation if sleep is already disabled. Detect observable setting conflicts and end the mode. Simultaneous writes of the same value by another utility cannot be distinguished reliably. Setup discloses that limitation; do not claim perfect restoration ownership.
- Recovery bounds are measured targets for named scenarios, not unconditional guarantees. Report measured bounds separately for Electron crash/stall, helper crash/stall, restoration command failure, recovery watcher failure, reboot, revocation, and removal. Simultaneous loss of both recovery processes or failed system power commands can leave recovery unresolved.
- Use a narrowly scoped privileged helper with one-time administrator setup. The helper owns the deadline and thermal/battery monitoring independently of Electron. An independent recovery owner uses durable recovery state written before a power change. Fresh Cat Code supervision is required; it cannot renew the original deadline. Account-wide passwordless sudo rules and restricted Apple entitlement arrangements are not the default route.


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
- Loss of supervision must promptly initiate restoration within the documented measured target scenarios. Failure to restore normal sleep behavior remains unresolved and visible until recovery succeeds; it must never appear as off.
- Existing task permissions and approval requirements do not change.
- A direct Stop action ends keep-awake mode without cycling through longer durations. Stopping the mode is not a promise that all jobs are cancelled.

## Work scope and activation

Capture the eligible runs when activation succeeds. Switching chats or closing a view does not change that set. Descendant work created to complete an included run remains included; unrelated new work does not join. An included parent waiting for an active child still counts as working.

All composer cups represent the same mode, scope, and deadline. They must not look like independent session controls. The accessible description and the ordinary notice both state that the mode covers current Cat Code work across chats.

The active notice identifies the original scope, for example “Covers 3 runs selected at activation across chats.” Its Inspect work action expands read-only details in the same notice surface: linked run names, observed status, and whether each still contributes to keeping the mode active. Count original top-level runs, grouping descendants beneath their parent rather than inflating the count. Completed runs remain identifiable until the mode ends. There is no selection or Add action. When the visible chat's current run is excluded, the notice explicitly says “This run is not included.” An excluded run can continue while the Mac is awake; it cannot extend this mode's lifetime.

First use completes safety disclosure and any required administrator authorization before activation. Cancelling or failing setup leaves the mode inactive. Do not display an active cup until activation is confirmed. A pending activation must remain distinguishable from a successful start without adding permanent text to the control.

**Proposed default:** when there is no eligible work, refuse activation and show “No running work to keep awake.” Do not arm the mode for a future run.

**Proposed default:** if every included run needs user input, end after a 60-second grace period. Active children continue to count. A provider or network outage may retry for up to two minutes when no other included work can progress, within the existing deadline. Pending approvals remain pending; neither ending nor Continue answers them.

## Coffee cup control

Place a 14px line icon in a 22px glyph slot in the composer's right-hand action group, before the account name. Use the slot geometry of `CacheExpiredIndicator` in [ComposerActionsBar.tsx](../../app/renderer/src/ComposerActionsBar.tsx). Coexist with the cache indicator without replacing its meaning.

Click cycles 15 → 30 → 60 → 120 → off. Selecting a duration starts the mode immediately after first-use prerequisites. Scroll and keyboard adjustment provide equivalent control. The lid-open, pending, unavailable, and recovery states override this ordinary cycling behavior as specified below.

Cycling is a shortcut, not the only way to stop. While active, the notice exposes a persistent Stop action that immediately begins ending the mode without changing the preset or extending the deadline. It is a keyboard-focusable button activated with Enter/Space; keyboard navigation must reach it without adjusting time. Hover/focus on the cup exposes the numeric popover and the corresponding notice details without moving keyboard focus. Keep the notice available while moving from the cup to its actions. No Stop button or explanatory prose is added inside the cup popover.

Hover or interaction reveals a small raised popover with an approximately 34×25px cup drawing and a numeral beside it. Four equal liquid levels and four ticks represent the presets. The selected tick uses the cup's color. The numeral uses 15px type, weight 580, and tabular figures; “min” is gray at 9.5px. Dark appearance uses cream `#f1dcc3` for the numeral; light appearance uses the darker equivalent below. The cup rises from the resting icon. Other than the existing “min” unit, the visual control contains no words, end-clock times, or action labels.

During operation, liquid drains below the selected tick, the number counts down, and restrained steam rises. After lid opening and successful sleep restoration, the cup is gray and steam becomes two stationary bars. The associated notice says “Lid opened. 18 minutes remaining. Work may still be running.” and offers Continue with lid closed. The remaining time continues to decrease. Never describe the jobs themselves as paused unless their observed status establishes that.

| State | Appearance | Cup interaction | Notice and allowed actions |
| --- | --- | --- | --- |
| Off | Empty gray line cup, no status mark | Select 15 minutes and activate | No routine notice |
| Setting up | Empty gray cup with dotted rim; no steam or running countdown | No duplicate setup or preset changes | Explain required setup; Cancel. Administrator authorization uses its own system surface |
| Starting | Dotted rim with a restrained pulse; selected preset is shown, no steam | No duplicate start or preset changes | “Starting lid-closed mode.” Cancel |
| Active | Caramel, draining liquid, restrained steam | Cycle duration; 120 → off ends the mode | Scope summary; Stop; End mode and sleep; Inspect work |
| Restoring sleep | Empty cup with a circular recovery mark; no steam | No start, Continue, or duplicate restore | “Restoring normal sleep.” No dismissal; no duplicate Retry while pending |
| Ended because lid opened | Gray cup, two stationary bars, decreasing remaining-time numeral | Continue with the original deadline | Lid-open explanation; Continue with lid closed; Dismiss |
| Protective end | Empty amber cup with warning mark | Fresh activation only after the reason is resolved | Specific end reason and observed work status when relevant; Dismiss |
| Unavailable | Gray cup with slash mark; no liquid or steam | No activation | Explain the unmet condition and its remedy. Retry only if a fresh check is meaningful |
| Sleep restoration unresolved | Empty red cup with warning mark | Retry restoration shortcut; never start a new mode | Persistent failure explanation; Retry; no dismissal |

Setting up and Starting do not count as active operation. A fresh countdown begins only when activation succeeds; a pending Continue retains the existing deadline and consumes its remaining time. Setup denial or a failed start produces a notice with the actual reason, not an active cup. Cancellation must not permit a late setup/start result to activate the mode. If a failed or cancelled activation may already have changed power behavior, enter Restoring sleep rather than claiming Off.

Every ending enters Restoring sleep before Off, lid-open continuation, or a protective-end state. Preserve the end reason during restoration. Show Off only after restoration is confirmed; failure transitions to the unresolved red state and clears continuation eligibility. A retry retains the red warning while in progress and returns to the failure state if unsuccessful. Successful recovery requires a fresh activation. Continue is available only after a successful initial restoration for lid opening. Dismissing a lid-open notice clears continuation eligibility without restarting or extending anything.

The earlier no-power plug glyph, unplug refusal shake, and power-disconnected state are removed. Battery operation is ordinary operation.

Use semantic theme roles for production colors. Dark appearance retains off gray `#75757b`, lid-open gray `#838389`, active caramel `#d4a274`, and numeral cream `#f1dcc3`. Light appearance uses espresso `#85552f` for active cup/tick and dark brown `#75451f` for numerals; these have calculated contrast of approximately 6.29:1 and 7.99:1 against the current white raised surface. Light-theme neutral states and units use contrast-appropriate semantic text roles rather than copying the dark grays. Warning and failure use the appearance-specific `tone-warn` and `tone-danger` roles.

Require at least 4.5:1 for the small numeral/unit text and 3:1 for essential cup outlines, marks, and selected ticks against their adjacent surfaces. Recheck composited liquid and thin strokes in the rendered design; solid-color calculations do not verify all elements. See [text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). Active, warning, and failure still need perceptual verification in both appearances.

Distinguish Off from protective end and restoration failure using the non-color marks above and the corresponding notice. The warning and failure explanations and actions must remain readable without identifying hue. No error is communicated only through a shake, steam, or fill animation.

## Timer rules proposed for review

The preset is the total allowance from the successful activation time. The normal numeral is remaining time, rounded up to whole minutes; expiry follows actual elapsed time rather than display rounding.

An explicit adjustment while active changes the total allowance relative to that same activation time. It never resets elapsed time. For example, ten minutes into a 15-minute run, choosing 30 leaves 20 minutes. Selecting an allowance already consumed ends the mode immediately. Hover, focus, reopening the popover, and repeated rendering do not renew anything.

Briefly show the selected preset while adjusting it, then return to remaining time. During adjustment, the same notice shows both meanings together, for example “30 minutes total; 20 minutes remaining.” Keep that pair available while the cup or notice is being inspected and update it after each adjustment. The accessible description provides the same distinction. This explanation belongs in the notice, not in a prose tooltip or the numeric popover. Do not show end-clock times or “min left” in the visual control.

The liquid is a preset scale, not a linear percentage of 120 minutes: 0 / 15 / 30 / 60 / 120 remaining minutes map to 0 / 25 / 50 / 75 / 100 percent of the usable fill height. Interpolate linearly within each adjacent band. Thus 20 minutes maps to roughly 33 percent fill; a selected 30-minute allowance retains its 50-percent tick while the liquid drains below it. The drain speed changes at band boundaries. The numeral is authoritative for time remaining. Include “Ticks mark 15, 30, 60, and 120 minutes” in the notice's expanded time detail.

After lid opening and successful restoration, click or Enter/Space means Continue, not “next preset.” The visible Continue with lid closed action in the notice does the same thing. Continue retains the included runs that are still eligible and the deadline in effect when the lid opened. It cannot add unrelated work, extend time, or bypass current safety checks. Scroll and arrows do not modify a lid-open deadline. Once time expires or no included work remains, Continue disappears and the control returns to ordinary fresh-start behavior. Activation or continuation checks that fail explain the reason in the notice and never show an active cup.

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

User cancellation, End mode and sleep, quitting, and shutdown initiate restoration. Ordinary macOS Sleep may be blocked while the override is active; setup and the active notice disclose this accepted limitation. Restarting the app must recover unresolved restoration and must never silently reactivate an old mode.

An unresolved restoration state takes precedence over lid-open continuation, completion, expiry, and other ending reasons. It remains visible across chat navigation and app restart. Closing the originating chat cannot dismiss a machine-wide problem. A retry only restores sleep behavior; it does not resume work or start another timer. During restoration, a pending state must not briefly appear Off or allow a new activation.

## Notices and accessibility

Keep the feature name, “Keep working with lid closed,” in the native title and accessible name. Include state, time remaining, action, and global scope in accessible descriptions as appropriate. Ordinary users get those explanations and named actions in the notice surface. Keyboard focus exposes the same numeric popover and notice details as hover. Hover/focus never activates, renews, or cancels the mode. Avoid continuous screen-reader announcements of the countdown.

Reuse the existing [BannerStack.tsx](../../app/renderer/src/BannerStack.tsx) presentation, but place this feature's notice once in the shared app shell, outside the chat/page/welcome branches. It must remain available across chats, Pages, the welcome screen, and split panes even when no composer is visible. The current chat-only account-health banner placement does not satisfy this requirement; account-health notices need not move.

While active, keep the notice's Stop and Inspect work actions available across those surfaces. Cup hover/focus and timer adjustment expose further detail in that same notice, never a second card. Inspect work expands there and returns focus predictably when collapsed. An inspection detail may collapse without ending the mode or hiding Stop. Named actions are ordinary keyboard-focusable controls; the cup's Continue and Retry interactions remain shortcuts to the same actions.

During restoration and unresolved recovery, the single shell notice is non-dismissible and takes priority over routine mode messages. It persists until restoration succeeds, including after navigation or restarting the app. Show Retry when it can be acted on and prevent duplicate retries while pending. A finished job does not hide it. Do not add the superseded activation panel, chrome countdown chip, or return-summary card.

Proposed copy:

| Situation | Banner and action |
| --- | --- |
| First-use safety note | “Keep it on a hard surface. Never in a bag.” |
| Active | “Covers 3 runs selected at activation across chats.” with Stop and Inspect work |
| Active in an excluded run | Add “This run is not included.” Scope details remain available |
| Adjusting duration | “30 minutes total; 20 minutes remaining.” Stop remains available |
| Lid opened after successful restoration | “Lid opened. 18 minutes remaining. Work may still be running.” with Continue with lid closed and Dismiss |
| Already waiting for approval | “Waiting for approval.” with a link to the relevant prompt |
| Thermal stop | “Lid-closed mode ended because your Mac got too hot.” |
| Battery reserve reached | “Lid-closed mode ended to preserve battery.” |
| Monitoring lost during operation | “Lid-closed mode ended because safety monitoring is unavailable.” |
| Activation unavailable | State the actual unmet condition without implying the mode started or ended |
| Restoration pending | “Restoring normal sleep.” Preserve the end reason separately |
| Restoration unresolved | “Couldn't restore normal sleep. Keep your Mac open and on your desk.” with Retry |

Messages must describe the observed state. End-reason copy identifies the mode, not a presumed job outcome. Add observed work status only when useful, such as “Build is still running” or “Tests were interrupted; check the result.” Power/restoration status is separate from work status, and restoration failure takes priority. Routine completion needs no extra card or coaching. Exclude post-sleep promotion from v1.

Reduced-motion mode uses static liquid and state changes without rising, shaking, or steaming animations. Verify light and dark contrast, keyboard behavior, narrow composers, multiple panes, and non-color state recognition. Tiny visual geometry must not shrink the existing usable hit target.

## Agent behavior

Proposed temporary instruction for included work:

> The user may be unavailable during this work window. Continue within the existing instructions and permissions. Leave optional questions for the final summary. If required information or approval is missing, preserve progress and report the blocker.

The window is not a promised return time. The instruction must cease to apply when the mode ends, including lid opening, and must not remain authoritative through transcript replay or continuation. Continue can reinstate it only while the mode is active. User input remains authoritative and is handled normally. Agents cannot activate the mode, extend time, relax safeguards, or interpret this instruction as additional permission.

The integration belongs to the [prompt surfaces owner](../prompts/2026-04-30-prompt-surfaces.md). No prompt changes are part of this specification edit.

## Authorization and pmset mechanism

[Current idle-sleep prevention](../../src/services/preventSleep.ts) uses `caffeinate -i`. That is not a promise of lid-closed operation. [Apple distinguishes forced sleep from idle sleep](https://developer.apple.com/library/archive/qa/qa1340/_index.html).

The supplied Insomnia report describes one-time installation of account-scoped sudoers permissions for specific power commands, followed by noninteractive `pmset` calls. It does not describe an app-exclusive privileged helper. Its recovery agent waits for an unexpired session's deadline and does not independently monitor battery or temperature; that recovery behavior is insufficient for this specification.

The pmset direction and tradeoffs above are approved. Settle and document:

- What administrator consent grants, whether it is app-specific or account-wide, and how to revoke it.
- Whether first-use setup avoids an administrator prompt on every activation.
- Measured recovery targets and observed bounds for specified crash, stall, monitoring-loss, and restoration-failure scenarios.
- How explicit user sleep, pre-existing sleep settings, and another keep-awake app interact with ownership and restoration.
- Reliable closed-lid display/backlight handling, supported configurations, and preservation of existing screen-lock behavior.

Do not adopt application freezing, audio muting, arbitrary fan control, or unrelated power-setting changes as part of this feature.

## Acceptance requirements

Before describing the feature as ready, demonstrate the approved tradeoffs and:

1. Battery activation succeeds; unplugging does not end or renew the mode; the agreed reserve ends it.
2. Scope remains the original work and its descendants through chat switches, new turns, and multiple composers.
3. Preset changes obey the documented elapsed-time rule, and the deadline advances while the lid is open.
4. Only a lid-open ending offers Continue, with the same deadline and scope and fresh safety checks.
5. Serious heat, critical heat, unavailable monitoring, app/helper crash and stall initiate protective restoration; report measured recovery bounds and their conditions. Inject protective readings for testing without overheating or deeply discharging the Mac.
6. Restoration failure remains red and actionable across navigation and restart; Retry cannot activate the mode.
7. Required approval is never bypassed; the temporary away instruction ends with the mode.
8. On supported physical hardware, timestamped workload evidence shows actual progress while closed, and end/recovery evidence distinguishes restored settings from observed sleep.
9. Display/backlight, locking, reopening, ordinary Sleep blockage during active operation, and End mode and sleep after confirmed restoration behave as disclosed on that hardware.
10. The actual animations, wheel input, keyboard controls, accessible descriptions, and both color themes are inspected. Synthetic state changes alone do not establish physical safety.
11. From every active preset, the notice's Stop action ends the mode directly with pointer or keyboard input, without passing through another duration. It remains available when no composer is visible.
12. A single non-dismissible restoration notice with Retry survives chats, Pages, the welcome screen, split panes, and app restart. Pending restoration never appears Off, accepts a new start, or offers Continue.
13. Lid-open wording distinguishes work from keep-awake mode; its visible Continue action retains the original deadline, which continues to elapse while the lid is open.
14. Scope inspection lists the original runs and their status without allowing additions; an excluded visible run is explicitly identified. Descendants do not inflate the top-level count.
15. Setup cancellation, authorization denial, start failure, unavailable capability, and restoration failure each have truthful feedback and the allowed actions from the state table. Late completion cannot reactivate a cancelled request.
16. Adjustment displays total allowance and remaining time together in the notice, and the liquid follows the stated piecewise scale. The cup popover remains numerals-only with its existing unit.
17. Both appearances meet text and essential-graphic contrast requirements; off, unavailable, protective end, and recovery remain understandable without relying only on color or motion.

## Design references and pending decisions

- [Chosen cup mock](../design-html/2026-10-13-lid-closed-cup-control.html).
- [Explored surfaces](../design-html/2026-10-13-lid-closed-mode-surfaces.html).
- [Cat Code design guide](../../DESIGN.md).

The two HTML files remain separate, untracked design-session artifacts and are visual references, not authoritative behavior. They were not changed by this specification. The chosen mock still has the superseded external-power states, resets remaining time to a full preset when adjusted, and stops its countdown in the lid-open state. Those behaviors conflict with this spec's battery policy, proposed elapsed-time rule, and original-deadline requirement. Its piecewise liquid mapping is captured above. Animation and wheel behavior remain unverified.

The implementation uses the specified elapsed-time adjustment, a 20-percent discharging reserve, and nominal thermal state before a fresh start after a thermal end. Blocked-work grace periods and final banner copy remain product integration work. The concrete privilege model is a narrow root launchd helper with independent recovery and one-time administrator setup, detailed in the [bounded experiment](../research/2026-10-14-lid-closed-pmset-experiment.md). Pending release evidence includes measured recovery bounds, hardware support, display handling, and actual input/color verification. The accepted power-control tradeoffs, battery-use, and cup-design decisions are not reopened by these pending items.
