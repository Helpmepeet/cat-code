# Plan: what we are going to do about the renderer freeze and the memory crash

Written 2026-08-14, after the incident recorded in
`docs/reports/2026-08-14-renderer-freeze-and-devtools-crash.md`.

This document exists to be understood before anything is built. It explains what
is broken, what we can and cannot fix today, and why most of the work below is
measurement rather than repair. If you only read one section, read
"Why this plan is mostly measurement".

## Where we are

Two separate things went wrong on 2026-08-14. They share a machine and a moment,
and nothing else.

**Problem 1: the app used far too much memory and the display process was
killed.** The renderer, which is the process that draws the window, had grown to
6.7 GB. Chromium has a rule that when it cannot get memory it needs, it shuts
itself down deliberately rather than continue in a corrupt state. That is what
happened. Opening DevTools is what asked for the memory that finally could not
be found, but any sufficiently large request would have done it. The same
shutdown happened on 2026-08-09 from a completely different trigger.

We know the memory was the problem. We do **not** know what was using it.

**Problem 2: the window stopped updating, and we do not know why.** For at least
two minutes, and possibly around fifteen, the app received everything correctly
and simply never redrew. Messages arrived, were handed to the display code, and
were acknowledged. The clock stopped. Clicks did nothing. The engine was
healthy the whole time and finished its work normally.

This is the more important problem, because it is the one that interrupted your
work, and it is the one nobody can currently explain.

## Why we cannot just fix problem 2

We have eliminated the plausible explanations, one at a time, on evidence:

- The engine was not stuck. It completed every turn, including one that finished
  two and a half minutes after the display process had already died.
- The messages were not lost in transit. They arrived and were acknowledged at
  every stage.
- The display code did not refuse them. It handed every message to all twenty of
  its internal stores unconditionally.
- The screen was not blocked by heavy work. Timers kept firing on schedule the
  entire time, which a busy or stuck process cannot do.
- The drawing layer had not deadlocked. The graphics process was idle.
- The display was not skipping redraws because nothing had changed. The messages
  were live streaming content, not repeated snapshots.

Two further explanations were proposed and both failed the same way. The first
was that the display code redrew but found nothing changed, and so skipped the
update. That cannot be right, because your clicks do not travel through the code
that could have gone unchanged, and a click would have forced an update. The
second was that the display was continuously restarting an expensive redraw and
never finishing it, which would have made the transcript's known inefficiency
the culprit. That cannot be right either, because a process doing that burns
processor time, and we measured it idle.

So we are out of hypotheses that fit the evidence. That is an honest statement
of position, not a shrug.

## Why this plan is mostly measurement

Three of the five items below add instrumentation rather than fix anything. That
is deliberate, and it is the part worth understanding before agreeing to it.

The reason is that during this incident, the instruments we had were not merely
silent. They were **actively wrong**:

- The memory probe reported 102 MB while the process was holding 6.7 GB. It
  measures only one small compartment of memory and is named as though it
  measures the whole thing. It misled two separate investigations, five days
  apart.
- The responsiveness probe reported a healthy 4.5 milliseconds throughout. That
  number is real but nearly meaningless: it proves timers were running, which
  tells us almost nothing about whether the window was updating.
- Nothing anywhere records whether the display actually redrew. The single most
  important question about this incident, "did it redraw or not", is not
  answerable by any log we keep.

The consequence is that we spent a day reconstructing what a single well-chosen
number would have told us immediately, and we still ended without a cause. If we
skip the measurement and guess at a fix instead, the most likely outcome is that
we change something, the freeze happens again, and we are exactly here again
with no more information than we have now.

There is a second reason, specific to problem 1. We genuinely do not know what
consumed 6.7 GB. Two candidates were examined and neither cleanly explains it,
because both are capped at sizes far too small. Picking one and "fixing" it
would give us no way to tell whether it worked, because we cannot currently see
the number we would be trying to move.

## What we are going to do

### 1. Measure real memory, from outside the renderer

Have the main application process sample the true memory of the display process
on a timer and record it.

**Why from outside:** it keeps working when the display process is frozen or
dying, needs no cooperation from the thing being measured, and cannot be wrong
in the way the current probe is wrong.

**What it buys:** the next occurrence produces a growth curve with timestamps
instead of an unattributable 6.7 GB. We will be able to see whether memory
climbs steadily with session length, jumps in bursts, or spikes at a specific
event. That single distinction decides where to look next, and no amount of
reading code can substitute for it.

**Cost:** small, self-contained, no effect on how the app behaves.

### 2. Count redraws, and count updates that changed nothing

Two counters exposed in the existing health report. One increments whenever the
display actually redraws. One increments when content arrives for a session and
produces no change at all.

**Why both:** together they distinguish the three possible states the freeze
could have been in. Either the display never tried to redraw, or it tried and
never finished, or it redrew and correctly found nothing to change. These look
identical in every log we currently keep, and they point at three completely
different bugs. One reading of these two numbers separates them.

**Cost:** small. Both are plain numbers, with no message content in them, so the
existing privacy contract on the health report is preserved.

### 3. Detect the freeze while it is happening

Compare, in the main process, how many messages were handed to the display
against how many the display confirmed it applied, over a rolling window. A
large gap with zero confirmations means the display has stopped.

**Why this specific comparison:** it is what actually caught this incident.
During the freeze the figures were 2,388 handed over against 0 applied. In
normal operation they track each other almost exactly. The gap is unmistakable.

**Why it must count rather than track high-water marks:** an earlier version of
this idea compared positions rather than counts, and we verified that under this
kind of load it would have reported nothing at all, because the buffer it reads
from discards records exactly when traffic is heavy. Counting does not have that
weakness.

**Cost:** moderate. This is the one item with real design content.

### 4. Investigate the replay bursts, and fix a logging bug alongside them

The app occasionally resends a whole buffer of messages at once, and we recorded
roughly 50,000 such records in 2.4 seconds, with the display process spiking to
859 MB. This still happens, which makes it the only part of this whole incident
that can be studied live rather than reconstructed.

Two harms are already established regardless of whether it explains the memory:
the spike itself, and the fact that these bursts write logs so fast that they
destroy the evidence for any other problem within minutes.

Alongside it, a genuine logging bug: these records are written before the app
decides whether to actually send anything, so the logs can report deliveries
that never happened. This already produced one false anomaly that was reported
up as evidence. Small fix, and it stops the logs from inventing mysteries.

### 5. Audit how session records are created and removed

There is a pattern in the display code where a message for a session it does not
recognise is silently ignored. If a session's record could go missing while
messages were still arriving, that would explain a frozen display.

This is **demoted, not dropped.** The evidence weakens it: you were clicking
during the freeze, and a click does not pass through that code, so it should
have forced an update regardless. It stays on the list because the pattern is
real, it has caused a confirmed bug here before, and the audit is cheap.

## What we are deliberately not doing

**Not adding memory limits or trying to give the renderer more room.** The
allocation that failed was tiny and arbitrary; it simply happened to be next in
line. Raising a ceiling moves the failure to the following arbitrary request. The
problem is unbounded growth, not an unreasonable limit.

**Not guarding against DevTools.** The crash happens because DevTools asks a
loaded process to re-read all its code. That is Chromium's behaviour and we
cannot make it safe on a process holding 6.7 GB. Building machinery to protect a
debugging tool from a state that should not exist is the wrong shape of fix. The
crash disappears when the memory problem does. Until then, the rule is simply
not to open DevTools on a window that has been streaming for a long time.

**Not rewriting the transcript to render incrementally.** SUPERSEDED the same
evening by `docs/reports/2026-08-14-renderer-memory-attribution.md`: measurement
shows 95% of the renderer is Blink PartitionAlloc against 182 MB of JavaScript
heap, which is the growth-curve condition this section set for reopening it.
Virtualization is back on the table but still not established, because
parked-session retention is an untested alternative that explains the same
numbers. The original reasoning is kept below for the record.

This was recommended early and withdrawn. The 2026-08-09 report attributed a crash to the transcript's
inefficient drawing, but that attribution was explicitly inferred rather than
proven, and this crash's failing allocation turned out to be somewhere else
entirely. Its last route back into relevance was the theory that redrawing was
continuously restarting, and the measurements rule that out. If item 1's growth
curve later points at drawing, this returns on evidence.

## How we will know any of it worked

For the memory work, the honest answer is that item 1 is what tells us. Without
it, any claim that a fix reduced memory is unverifiable, which is the main
argument for doing it first.

For the freeze, success is not "it stopped happening", because we cannot yet
cause it or prevent it. Success is that **the next occurrence produces an
answer instead of a reconstruction**: a record in the log within a minute saying
the display has stopped, and two counters that say which of the three possible
failures it was. That is what converts this from an open-ended investigation
into a bug with a known mechanism.

## The risk in this plan, stated plainly

We may build all of this and still not catch the freeze, either because it does
not recur soon or because it turns out to be something none of the three
counters distinguish. That is a real possibility.

The alternative is worse. The evidence from this incident is largely gone: the
logs covering the start of the freeze were overwritten during the investigation
itself, and the process that could have been examined was destroyed by the act
of looking at it. We have already run the experiment of investigating this
after the fact, twice. It cost two days across two incidents and produced no
mechanism either time.

## Scope notes

None of this changes what the application accepts from outside, so no new
validation surface and no security review beyond the standing baseline. The
health report additions stay as plain numbers with no message content. No locked
architectural decision is touched. Each change still runs the full `app/` test
battery and the hardening smoke per CLAUDE.md §3.
