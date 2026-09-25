# Cat Code Analytics page: design review

Reviewed September 24, 2026, at HEAD `102dfc0f`. Scope: report only. No code was changed.

Implementation followed this review on September 24, 2026. The current Analytics page uses local-calendar aggregation, the five-card layout, the four agreed Auto mode display groups, and one bottom exact-values disclosure. The mockup below records the earlier visual review; the running page and its tests are the implementation reference.

**The main problem is that Analytics has no hierarchy. It shows every chart it can compute at equal weight, then explains itself in small grey notes.** About 13 charts, five metric cards, six separate "exact values" disclosures, and up to seven partial-history warnings share one scrolling column. The page also runs its own palette of about 14 hues instead of the app's tokens. Some states are broken outright: hover and pressed backgrounds use an undefined CSS variable, and the auto-mode outcome colors are swapped between two adjacent charts.

The agreed direction keeps the five summary cards and model donut, simplifies the palette and copy, and removes Tool activity and Execution timing.

[Before and after mockup](../design-html/2026-09-24-analytics-redesign.html)

## Decisions after review

Agreed item by item on September 24, 2026, then updated after the follow-up review. Where these differ from recommendations further down, the decisions win. The mockup linked above predates the follow-up decisions and is retained as a review artifact.

- **Header:**
  - The title becomes "Analytics".
  - The date line moves under the title, in local time ("Sep 18 to 24 · Updated 9:05 PM").
  - The refresh button is round, and the range buttons are pills with an accent tint on the selected one.
  - There is no partial-history message anywhere.
  - If the saved snapshot is from another day, include the date in "Updated". A failed refresh must be apparent at the refresh control while the old snapshot remains visible.
- **Summary cards:** keep all five, with their trend lines, green and red change figures, and card boxes. Rename "Sessions used" to "Sessions".
- **Token chart:**
  - Keep the smooth stacked area.
  - Title it "Tokens" and drop the total beside it.
  - Use three types (Input, Cache, Output) in blue for Input, pale violet for Cache (light `#c4b5fd`, dark `#4c3d7a`), and pink for Output, and label the gridlines. Cache is about 80% of the chart, so it gets the quietest color. The Prompt cache "Cache reads" swatch uses the same pale violet.
  - Mark the selected day with a highlight band, and show its details directly under the chart, headed "Tue, Sep 22" with a "Clear" link.
  - The session table keeps Session, Tokens, and Est. cost, with short numbers.
  - Session names open their sessions. Show up to ten contributors; if the list is truncated, label it "Top N of M sessions" and keep day totals based on all sessions. The mockup's nine-session day should show nine rows, not an unexplained three.
- **Exact-value tables:**
  - Remove the per-panel "Exact … values" sections: route, command block rate, decision, block reason, and selected tool.
  - Replace "Accessible values table" with one collapsed "View as table" at the bottom of the page.
  - There are no per-panel Table buttons. The chart, legend, and selected-day figures use compact numbers, so the bottom disclosure must provide full-precision values for every displayed chart and its underlying series. Group tables by chart within that one disclosure, including daily tokens by type and model, prompt cache, models, tools and tool outcomes, hourly activity, and auto-mode routes, outcomes, command block rate, and reasons.
  - Chart inspection also needs keyboard and touch access. Use native controls, visible focus, meaningful headings, and a consistent selection and Clear action in the implementation; the static mockup does not demonstrate these.
  - Move tests for removed per-panel tables to the consolidated disclosure. Preserve exceptional-only auto-mode cases and full-precision assertions.
- **Prompt cache:** keep the trend chart, drawn from 0%. Drop the subtitle, and show three rows: Cache reads, Cache writes, and Input. "Input" means uncached input. The percentage is cache reads divided by uncached input plus cache reads plus cache writes; the token chart's Cache series combines reads and writes. Show the definition accessibly without restoring a long subtitle. Unknown cache writes and any percentage that depends on them are unavailable, not zero.
- **Removed:** the Tool activity panel and the Execution timing panel.
- **Model usage:** keep the donut, with model colors that no longer clash with the token colors, the count of distinct real models in the centre, and no footnote. "Other" is a grouped slice, not a model; its presence must not inflate the count.
- **Tools:** keep the bars and Error rate over time, with round-number ticks and no build-coverage note. Add an Other bar when needed so the bars reconcile with the Tool requests card.
- **Heatmap and dates:** title the heatmap "Activity by hour", use local calendar days and hours throughout Analytics, and show five accent-color steps with a distinct zero and a Less/More key. Selection from the heatmap keeps the current range. A local hour selected across midnight must resolve to the same local day in the token chart and session details. The data aggregation must handle timezone changes and 23- or 25-hour daylight-saving days; changing labels alone is insufficient.
- **Unavailable data:** use a dash for values that cannot be calculated and zero only for a confirmed zero. Leave future heatmap hours blank, distinct from past zero activity. If no usable data exists, show an empty or error state rather than charts filled with zeros. Do not restore a partial-history banner or repeat partial-history notes.
- **Auto mode:** give the panel a title. Keep Decision flow, Command block rate, Decisions over time, and Block reasons. Show four display groups with the same labels and colors in the flow, bars, and legend: Allowed (`allowed`), Blocked (`policy_blocked`), Error (`operational_error`, `review_required`, `unknown_outcome`, `incomplete`), and Cancelled (`cancelled`). The Error group is a display simplification, not a claim that every included raw outcome is an operational error; explain its composition on inspection and expose the seven raw counts in "View as table". Decision flow and Decisions over time must account for all attempts and calculate any displayed percentages using all attempts as their shared denominator. Fit the flow to the available width. This requires changes to graph/state construction, not just colors.

## How this was reviewed

Three read-only reviews ran in parallel: visual design, UX and structure, and copy and data presentation. I rechecked the main claims against source before writing them here.

| What | Evidence | Limits |
| --- | --- | --- |
| `UsagePage.tsx` and its 12 chart components, 8 stylesheets, and 12 state modules under `app/renderer/src/` | Source reading at `102dfc0f` | Nothing was rendered: bun and the app dependencies are not installed in this environment. Layout and rendered-size claims are **(inferred)** from CSS and chart geometry. |
| Contrast ratios | Computed from the hex values against the page ground | Not measured on screen. Glass mode and custom accents not exercised. |
| Comparison with the rest of the app | `theme.css`, `AccountsPage.tsx`, `AccountsUsageCharts.tsx`, `Sidebar.tsx` | Source only |

Items marked **Verified** were rechecked directly in source after the parallel reviews finished.

## What the page renders today

In order, from `UsagePage.tsx:57-91`:

1. Header: h1 **Usage** (the sidebar calls it **Analytics**), refresh button, 7 days / 30 days / All
2. Freshness line: `YYYY-MM-DD to YYYY-MM-DD UTC · Updated HH:MM UTC`
3. Status line
4. Five metric cards
5. Token flow (stacked area, By type / By model)
6. Prompt cache | Tool activity (defaults to **Error rate**)
7. Execution timing (p50 / p95, timeline)
8. Model usage (donut) | Tools (bars, plus a second error-rate-over-time chart with Commits markers)
9. An **untitled** auto-mode panel with four charts: decision flow (sankey), command block rate, decisions over time, block reasons
10. Token volume by hour (heatmap, always 7 days)
11. Selected day detail with session contributors (only when a day is picked)
12. "Accessible values table" (three tables, up to 10 columns)

Every panel uses the same `UsagePanel` component. The only variation is `wide`, and `.usage-panels` is a single column, so `wide` has no effect. Errors appear in four places and the cache share in three. The second-best position on the page goes to cache share and tool error rate. Which models used the tokens only appears after execution latency.

## Fix first: broken, not just ugly

### 1. Hover and pressed backgrounds never render. Verified.

`var(--color-surface-hover)` is used 9 times across `usageDashboard.css`, `usageToolErrorTrend.css`, and `usageTiming.css`. It is not defined anywhere in `app/`, so those backgrounds resolve to transparent. Row hover does nothing, and the pressed states of the tool bars, error rows, and the Commits toggle are invisible.

**Fix:** use `--color-shell-hover` for `:hover` and `--color-shell-active` for `[aria-pressed=true]` (`theme.css:769`).

### 2. The same auto-mode outcome has a different color in adjacent charts. Verified.

| Outcome | Decisions bars (`usageAutoModeBars.css:15-16`) | Decision flow (`usageAutoModeFlow.css:18-19`) | Timeline (`usageTiming.css:26`) |
| --- | --- | --- | --- |
| `operational_error` | violet | slate | n/a |
| `cancelled` | slate | violet | amber |

**Fix:** define one color for each of the four agreed display groups and use it consistently in Decision flow, Decisions over time, and their legend. Keep the seven raw outcomes distinct in the exact table.

### 3. Clicking a day shows the result far down the page. Verified.

A click in Token flow selects a day, but:

- The day detail renders at `UsagePage.tsx:82-86`, below timing, models, tools, four auto-mode charts, and the heatmap.
- Token flow only sets `aria-pressed` on the chosen day (`UsageDashboardCharts.tsx:79`) and draws nothing. `.usage-selected` and `.usage-selection-underline` (`usageDashboard.css:73-74`) are defined but no component uses them.
- Nothing scrolls to the detail or moves focus there.

This contradicts the design in `docs/reports/2026-09-16-usage-session-drilldown.md`, which places the selected-day table directly below the main plot.

**Fix:** render the day detail directly under Token flow, draw a selected band with `.usage-selected`, and move focus to the detail heading.

### 4. Clicking the heatmap silently switches the page to 7 days. Verified.

`UsagePage.tsx:80` calls `onSelect={date => updateSelection({ range: '7d', date })}`. A user on 30 days who clicks an hour sees every card and chart jump to 7 days. The heatmap also keeps its own `pinned` state (`UsageActivityCharts.tsx:11`), so **Clear selection** leaves the cell highlighted.

**Fix:** keep the current range and select that date, or in All the bucket that contains it. Drive the heatmap highlight from the page selection.

### 5. Two percentages in one card use different denominators. Verified.

- **Tool activity:** the headline error rate is errors / results, while the **Errors** share directly below it is errors / requests (`UsageOverviewDetails.tsx:59`). The card shows two different error percentages.
- **Decision flow:** the hover readout divides by `layout.total`, "normal completed decisions" (`UsageAutoModeFlow.tsx:31,122`). The "Exact route values" table under it divides by `attempts`, "Share of all attempts" (`:69-70,153`). The same route gets two different percentages.

**Fix:** use one denominator per card and state it once.

### 6. Decision-bar labels shrink to near-illegible (inferred)

`plotWidth = Math.max(640, buckets.length * 64)` (`UsageAutoModeBars.tsx:34`) is drawn at `width:100%` inside half a panel, and every bar gets a full ISO date label. At 30 buckets, 1,920 units fit into roughly 540px, so the 10px axis text renders at about 3px. This is the only chart that does not measure its container.

**Fix:** use `useUsageChartWidth()` and the shared tick thinning (`usageChartTicks`, `usageChartDate`) like the other charts.

## Color

- **Too many hues, and they collide.** About 14 hues come from three palette functions: `usageModelColors`, `usageGraphColors`, and `usageColors`, which only a test still uses. Pairs that mean different things are nearly identical:
  - Cache reads `#7c3aed` and model Luna `#8a52ee`: 1.23:1 between them
  - Fresh input `#2563eb` and model Sol `#3b84f7`: 1.43:1
  - Output `--usage-pink` and model Other `--usage-model-pink`

  The By type / By model toggle keeps these colors while swapping what they mean. Violet alone has six meanings: cache, the sessions sparkline, timeline model bars, retry links, the commit marker, and an outcome.
- **Model colors fail contrast in light mode.** They are single hex values rather than `light-dark()` pairs (`usageDashboard.css:21-25`). Against white: yellow `#f6c543` is 1.62:1, pink `#f077af` 2.64:1, orange `#ee7c38` 2.77:1. All are below the 3:1 minimum for graphics.
- **It runs its own theme.**
  - The page ground is `light-dark(#f7f6f6,#0a090b)` instead of `--app-bg`, and the greys are mauve-tinted rather than the app's zinc.
  - There are zero uses of `--color-accent` or `--color-tone-*`, so selection is always blue and the heatmap always pink, whatever accent the user picked.
  - Warning amber `#d97706` is 3.19:1, against 5.01:1 for the app's tuned `--tone-warn`.
  - Accounts' own usage charts use `text-accent`, so the two usage surfaces already disagree.
- **Red and green are used for non-status meaning.**
  - Every delta is green when up and red when down, so spending more tokens reads as good (`usageDashboard.css:36-37`).
  - The selected tool chip gets a red border (`usageToolErrorTrend.css:11`).
  - The "Partial history" note is amber in auto mode and grey everywhere else.
- **Heatmap ramp.**
  - Nine steps, and the lowest adjacent steps differ by only 1.05:1 and 1.18:1.
  - Zero looks the same as the lowest bucket.
  - The key reads "Less … 4.2M" on a square-root scale.
  - The pink hue has no relation to the token color or the accent.
- **Tooltips disagree.**
  - Token flow's tooltip is hard-coded dark (`#171719`) even in light mode. The other two tooltips use panel colors, and the three have 8, 7, and 6px radii.
  - The hover-dot ring `#171719` is a heavy black ring in light mode and invisible (1.04:1) in dark.

**Fix:** use one validated categorical palette of six to eight `light-dark()` tokens. Keep token-type hues out of the model palette, and retain the agreed red and green change figures on summary cards. Map the page onto the app's tokens: `--color-surface-raised` for panels, `--color-text-muted` and `--color-text-subtle` for text, `--color-tone-*` for status, and `--color-accent` for selection and the heatmap base. Give the heatmap five `color-mix()` steps and a distinct zero. Build one tooltip style from tokens.

## Typography, spacing, and layout

- **Type scale.**
  - 16 font sizes between 10 and 32px.
  - Six hero-number sizes: 32, 28, 26, 25, 22, and 20. The largest number on the page is the cache share, in a secondary panel.
  - Axis labels, table heads, and latency labels are 10px.
  - Only DM Mono 400 and 500 are loaded, but the token-flow total asks for mono 600, so the browser synthesizes the bold **(inferred)**.
- **Three heading systems.**
  - Panel headings are 10.5px mono uppercase with 0.15em tracking. Metric labels use 0.12em, and latency labels 11px with 0.08em.
  - Auto-mode headings are sans sentence case at two sizes: 14px/600 and 13px/550.
  - Four panels have no `title` (`UsagePage.tsx:65,70,71,78`). Three of those draw their own heading, and auto mode has none, so the outline jumps from h1 to h3.
- **Grid.**
  - 2-up rows use `align-items:start`, so their bottoms are ragged. The roughly 210px donut sits beside a much taller Tools card **(inferred)**.
  - One 2-up row is `1fr 1fr` and the next is `1fr 1.18fr`, so the gutters do not line up.
  - Fixed `min-width`s force horizontal scroll at ordinary window sizes: the sankey at 760px, the heatmap at 580px, the timeline and session table at 640px.
  - At 680px the five metric cards wrap two per row, leaving an orphan cell.
- **Cards inside cards.**
  - The latency grid is a bordered, rounded card inside a panel.
  - The timeline is a tinted, bordered box inside a table.
  - `.usage-auto-mode{margin:16px 0}` roughly doubles that panel's top padding.
  - Token flow uses a 14px radius with 22/20px padding, while every other panel uses 10px with 17px.
  - Paddings of 13, 15, and 17px do not follow any scale.
- **Icons do nothing.** `.usage-icon{display:none}` (`usageDashboard.css:65`) hides every panel icon, yet `UsageIcon` still renders and each panel still passes an `accent`. The accents are also mislabeled: the people icon is assigned to Execution timing and Model usage.
- **Controls feel heavy.** The four segmented controls use an inverted solid pill, the heaviest shape on the page. Other pages use `bg-accent/10`-style selection.
- **Out of line with other pages.** Page padding is 18px versus `px-7` elsewhere, the h1 is 19px versus `text-lg`, and the max width is 1180px versus 1000px.
- **Chart details.**
  - Y ticks sit at thirds of the maximum, which produces labels such as "3.3K" and "66.7%".
  - Token flow has no y-axis labels.
  - Gridlines are dashed in one chart and solid in the rest, and use two different colors.
  - Plot areas start at x = 0, 40, 42, or 44, so charts stacked on the page do not line up.
  - The cache-share area fills down to a truncated baseline, which exaggerates changes.

**Fix:**
- Every panel gets a `title` and uses one heading style.
- Use one hero number size and a five-step type scale (11, 12, 14, 20, 28).
- Stretch 2-up rows and give them matching columns.
- Let charts measure their width instead of setting a `min-width`, and use `repeat(auto-fit,minmax(160px,1fr))` for the cards.
- Use one radius and one padding, and remove the inner borders.
- Use nice ticks, one gridline style, and one left inset.
- Delete `UsageIcon` or switch it to the Sidebar icon set.

## Too much text

Across the Analytics files there are roughly 250 to 300 user-visible strings, plus 63 `aria-label`, `title`, and SVG `<title>` attributes. About 55 to 65 visible strings and notes can go without losing meaning. Many current strings break the repository rule in `CLAUDE.md` §7: no repeated visible state, no narrated implementation, and status text only when it changes what the user should do. There are no em dashes.

### Partial history warns up to seven times at once. Verified.

When history is partial, all of these can render at once:

- The page status line (`UsagePage.tsx:60`)
- The cache-trend note (`UsageAreaTrend.tsx:70`)
- The day readout (`UsagePage.tsx:84`)
- Three auto-mode "Partial history" notes (`UsageAutoModeFlow.tsx:99` or `:107`, and `UsageAutoModeBars.tsx:49,104`)
- The values-table note (`UsagePage.tsx:88`)

On top of that, "Unavailable" replaces the cache value in the metric card, the Prompt cache headline, and every table row. "?" marks sit on the Token flow zero days. The suffix ", partial history" is appended to every chart hotspot's `aria-label`, including all 168 heatmap cells.

**Fix:** remove all partial-history banners, notes, and repeated label suffixes. Represent affected values with a dash and an accessible unavailable reason; never turn missing data into zero. Keep the snapshot's update time visible, and identify a failed refresh at the refresh control.

### Implementation narration to delete

| Where | Text today | Change |
| --- | --- | --- |
| `UsagePage.tsx:88` | "Transcript records include user, assistant, system and attachment records in main sessions." | Cut, along with the Transcript records column, which appears nowhere else |
| `UsageTiming.tsx:54` | "…Intervals share one wall-time scale, so overlaps remain visible." | Cut, or "Last N events" |
| `UsageTiming.tsx:31` | "Transport retries within one attempt are not counted separately." | "Successful responses only." |
| `UsageTiming.tsx:34` | "N invalid timing records were excluded." | Cut |
| `UsageAutoModeBlockRate.tsx:108` | Four-sentence `aria-label` describing how the chart is drawn | "Command block rate, 0 to N%" |
| `UsageAutoModeBars.tsx:54`, `UsageToolErrorTrend.tsx:65` | "…Exact values follow the graph." (false while the table is collapsed) | Cut |
| `UsageToolErrorTrend.tsx:84-86` | Build coverage notes and a raw `…T10:11:12.345Z` timestamp | Cut the notes; format the date |
| `UsageSessionContributors.tsx:66` | Three-sentence truncation note | "Top 10 of 35 sessions. Day totals include all." |
| `UsageSessionContributors.tsx:67` | Cost disclaimer, about 30 words, under every day table | Tooltip on the Est. cost header: "API list prices; excludes cache writes." |
| `usageDashboardState.ts:21-23` | "Usage data could not be verified." / "…exceeded the processing limit." | "Usage could not be loaded." |

### Dates, times, and numbers

- **Four date formats.** ISO `2026-09-18`, `Sep 18`, `09-18`, and a raw ISO timestamp all appear.
- **UTC everywhere.** "UTC" appears about 30 times. The hour-of-day heatmap is in UTC, so it cannot answer "when do I work" for a user outside UTC.
- **"Updated HH:MM UTC" has no date** (`UsagePage.tsx:58`). At startup the app restores a saved snapshot that may be days old, so a stale or failed refresh looks the same as a fresh one.
- **Number formats are mixed.**
  - `en-US` is hard-coded.
  - Compact and full numbers mix within one card.
  - Percentages always carry one decimal ("100.0%").
  - Costs run to five decimals ("<$0.00001").
  - Text columns such as Tool are right-aligned.

**Fix:** group and show days and hours in local time throughout the page. Use one date style ("Sep 18", "Sep 1 to 7"). Show the date or a relative age when `asOf` is not today. Show costs to the cent. The aggregation and selection contract must change with the labels; a fixed UTC-to-local hour rotation is insufficient across midnight and daylight-saving changes.

### One concept, one name

| Concept | Names in use today | Use |
| --- | --- | --- |
| The page | Analytics (nav), Usage (h1), "analytics data" (refresh button label) | One name everywhere |
| Cache share | Cached input, Prompt cache, Cached input share, "Share of input tokens served from cache" | One |
| Blocked outcome | Policy blocked, Policy-blocked, Policy-denied commands, Blocked | Blocked |
| Allowed outcome | Allowed, Approved | Allowed |
| No tool result | Unmatched, No matched result, without a matched result | No result |
| Missing value | Unavailable, Not available, Not applicable, No data, No matched results, ? | Hide the element, or "None" for zero |
| Uncached input | Fresh input | Uncached input |
| Latency | p50 / p95, First text | Median / Slowest 5%, Time to first token |
| Values table | Accessible values table | View as table |

`Allowlist` is used as a sankey node label (`usageAutoModeState.ts:97`). It is on the banned-term list in `userVisibleText.test.ts:75`, but it gets past the test because the test only checks strings that contain a space (`:220`). Rename the label to "Allow rules", and consider tightening the test.

## Other UX problems

- **Keyboard.**
  - Every Token flow day is its own tab stop: up to 180 in All (`MAX_USAGE_ALL_BUCKETS`).
  - In Token flow, arrow keys *select* days, re-rendering the page and firing the polite live region on every press. In the other charts, arrows only move focus.
  - Escape never clears the selection.
  - **Fix:** use a roving tabindex, arrows to move and Enter to select everywhere, and Escape to clear.
- **The All range hides session lists without saying why.** Contributors are skipped when `range === 'all'` (`UsagePage.tsx:85`). Add "Session lists cover the last 30 days" and a "Show in 30 days" action.
- **The empty state still draws every panel as zeros.** When there is no usage, show the status line only.
- **Hover-only information.**
  - The period a delta is compared against lives only in `title` on an element that cannot take focus.
  - Timing definitions are also `title`-only.
  - Error-trend points respond to the mouse only.
  - **Fix:** show "vs prior 7 days" visibly above the cards.
- **Metrics are shown more than once.**
  - Total tokens appears as a card and again as the Token flow headline.
  - Model share appears three times: the Token flow legend, the donut, and the donut key.
  - Error rate is charted twice.
  - The bucket note ("N-day totals") can appear three times.
- **The five exact-value disclosures all have different names,** while the heatmap and donut have none. Replace them with the agreed single bottom "View as table" disclosure, with full-precision sections for every retained chart.

## Page structure after decisions

1. **Header:** Analytics, local date range and update time, round refresh control, and pill range control. No partial-history message.
2. **Five summary cards:** keep the boxed cards, trend lines, and red/green change figures.
3. **Tokens:** stacked area with a selected-day band and three token types. Put selected-day figures and session contributors directly below the chart.
4. **Prompt cache and Model usage:** retain the cache trend with three explanatory rows and the donut with a real-model count.
5. **Tools:** request bars, including Other when needed, and Error rate over time.
6. **Activity by hour:** local-day and local-hour heatmap, coordinated with the current range and selected day.
7. **Auto mode:** titled panel with Decision flow, Command block rate, Decisions over time, and Block reasons. Use the four agreed display groups and reconcile all counts.
8. **View as table:** one collapsed disclosure at the bottom, with full-precision sections for the retained charts and raw auto-mode outcomes.

## Suggested order of work

| Step | Scope | Size |
| --- | --- | --- |
| 1 | Broken states: the undefined hover token, day detail under Tokens with a visible band, the heatmap range switch, and measured chart width | Renderer and CSS work |
| 2 | Data contracts: local-day aggregation and selection, four auto-mode display groups over seven raw outcomes, conserved flow counts, and one denominator | Data/state and graph work; verify timezone and exceptional-only histories |
| 3 | Copy diet: remove partial-history messages, handle unavailable and stale values, use local dates and one vocabulary, and delete narration | Renderer and state work; update string tests |
| 4 | Palette and tokens: one `light-dark()` palette, app surfaces, neutrals, tones and accent, the heatmap ramp, and one tooltip style | Renderer and CSS work |
| 5 | Layout and access: headings, chart sizing, five cards, three cache rows, one exact-values disclosure, and keyboard/touch inspection | Renderer work; needs GUI and accessibility verification |

## Also noticed

- Code with no production use:
  - Components: `UsageActivityRows` (`UsageDashboardCharts.tsx:126`) and `UsageToolErrors` (`UsageActivityCharts.tsx:67`)
  - CSS rules: `.usage-donut-total`, `.usage-zero-bar`, `.usage-chart-summary`, `.usage-bar`
  - Rules defined twice, including two focus rings with different colors
  - `usageColors`, which only `UsagePage.test.tsx` uses
- The comment at `App.tsx:1261` says analytics "ride the same accounts worker run". `docs/maps/web-app-runtime.md` describes an independent worker, so the comment looks stale.
- Nothing is memoized. Every selection change, including each arrow press in Token flow, re-renders the sankey layout, 168 heatmap cells, and the tables inside closed `<details>`, which stay in the DOM (up to 180 rows by 11 columns).
- `key={range}` resets the Tool activity measure on every range change. Token flow's By type / By model mode and hidden series reset on navigation, while range and date persist.
- No Usage test checks for em dashes, unlike several other pages.
