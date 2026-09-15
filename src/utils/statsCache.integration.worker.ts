const fakeNow = process.env.STATS_FAKE_NOW
if (!fakeNow) throw new Error('STATS_FAKE_NOW is required')
const RealDate = Date
const nowMs = new RealDate(fakeNow).getTime()
class FakeDate extends RealDate {
  constructor(value?: string | number | Date) {
    super(value === undefined ? nowMs : value)
  }
  static override now(): number {
    return nowMs
  }
}
globalThis.Date = FakeDate as DateConstructor

const { aggregateClaudeCodeStatsForRange } = await import('./stats.js')
const stats = await aggregateClaudeCodeStatsForRange('all')
console.log(JSON.stringify({
  totalSessions: stats.totalSessions,
  totalMessages: stats.totalMessages,
  inputTokens: stats.modelUsage['claude-sonnet-4-5-20250929']?.inputTokens ?? 0,
  longestDuration: stats.longestSession?.duration ?? null,
  notice: stats.dataQualityNotice ?? null,
}))
