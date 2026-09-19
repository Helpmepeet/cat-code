import type { UsageRangeSummary } from '../../shared/usageDashboard.js'
import { UsageAutoModeBars } from './UsageAutoModeBars.js'
import { UsageAutoModeBlockRate } from './UsageAutoModeBlockRate.js'
import { UsageAutoModeFlow } from './UsageAutoModeFlow.js'
import './usageAutoMode.css'

export function UsageAutoMode({ summary }: { summary: UsageRangeSummary }) {
  return <section className="usage-auto-mode" aria-label="Automatic permission decisions">
    <UsageAutoModeFlow summary={summary.autoMode}/>
    <UsageAutoModeBlockRate summary={summary.autoMode} startInclusive={summary.startInclusive} endExclusive={summary.endExclusive} bucketDays={summary.bucketDays}/>
    <UsageAutoModeBars summary={summary.autoMode}/>
  </section>
}
