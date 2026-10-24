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
const { generateHeatmap } = await import('./heatmap.js')
const range = process.env.STATS_RANGE ?? 'all'
if (range !== 'all' && range !== '7d' && range !== '30d') throw new Error('Invalid STATS_RANGE')
const stats = await aggregateClaudeCodeStatsForRange(range)
let screen: string | undefined
if (process.env.STATS_SCREEN === '1') {
  const { createElement } = await import('react')
  const { PassThrough } = await import('node:stream')
  const { default: stripAnsi } = await import('strip-ansi')
  const { render } = await import('../ink.js')
  const { AppStateProvider } = await import('../state/AppState.js')
  const { call } = await import('../commands/stats/stats.js')
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 50 })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  let ready: () => void
  const rendered = new Promise<void>(resolve => { ready = resolve })
  stdout.on('data', chunk => {
    output += chunk.toString()
    if (stripAnsi(output).includes('Current streak:')) ready()
  })
  const node = await call(() => {}, undefined, '')
  const instance = await render(createElement(AppStateProvider, null, node), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  let timer: ReturnType<typeof setTimeout>
  try {
    await Promise.race([rendered, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Stats screen did not finish rendering')), 2500)
    })])
    screen = stripAnsi(output)
  } finally {
    clearTimeout(timer!)
    instance.unmount()
    instance.cleanup()
  }
}
console.log(JSON.stringify({
  totalSessions: stats.totalSessions,
  totalMessages: stats.totalMessages,
  inputTokens: stats.modelUsage['claude-sonnet-4-5-20250929']?.inputTokens ?? 0,
  longestDuration: stats.longestSession?.duration ?? null,
  notice: stats.dataQualityNotice ?? null,
  dailyActivity: stats.dailyActivity,
  streaks: stats.streaks,
  heatmap: generateHeatmap(stats.dailyActivity, { terminalWidth: 14, showMonthLabels: false }).split('\n').slice(0, 7),
  ...(screen === undefined ? {} : { screen }),
}))
