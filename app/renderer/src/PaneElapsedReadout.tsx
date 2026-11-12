import { useEffect, useState } from 'react'
import { fmtElapsed, fmtTok } from './appModel.js'
import type { OutputTokenReading } from './outputTokenState.js'

/** The original turn start survives pane switches; hidden panes catch up on reveal. */
function usePaneElapsed(turnStartedAt: number | null): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (turnStartedAt === null) return
    let timer: ReturnType<typeof setInterval> | undefined
    const sync = () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      if (document.hidden) return
      setNow(Date.now())
      timer = setInterval(() => setNow(Date.now()), 1000)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      if (timer !== undefined) clearInterval(timer)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [turnStartedAt])
  return turnStartedAt === null ? 0 : Math.max(0, now - turnStartedAt)
}

export function PaneElapsedReadout({ turnStartedAt, outputTokens }: {
  turnStartedAt: number | null
  outputTokens?: OutputTokenReading
}) {
  const elapsedMs = usePaneElapsed(turnStartedAt)
  const tokenDescription = outputTokens?.quality === 'unavailable'
    ? 'Output count unavailable for this turn.'
    : 'Main-chat output, including reasoning and tool inputs. Excludes separate agents.'
  // Match the engine's strict 30-second gate, including on remount and reveal.
  const showTokens = outputTokens && outputTokens.quality !== 'unavailable' &&
    outputTokens.tokens > 0 && elapsedMs > 30_000
  return <span
    className={outputTokens ? 'shrink-0 font-mono text-[11px] tabular-nums text-text-subtle' : 'font-mono tabular-nums text-text-subtle'}
    title={outputTokens ? tokenDescription : undefined}
  >
    {fmtElapsed(elapsedMs)}
    {showTokens ? <span aria-label={`${outputTokens.quality === 'estimated' ? 'Estimated' : 'Reported'} output: ${fmtTok(outputTokens.tokens)} tokens. ${tokenDescription}`}>
      {' · ↓ '}{fmtTok(outputTokens.tokens)} tokens
    </span> : null}
  </span>
}
