export type ScreenKind = 'computer' | 'browser'
export type ScreenActivityState = {
  runKey: string | null
  computerId: string | null
  browserSequence: number | null
  revealed: boolean
  latest: ScreenKind | null
}
export const EMPTY_SCREEN_ACTIVITY: ScreenActivityState = {
  runKey: null, computerId: null, browserSequence: null, revealed: false, latest: null,
}

/** Observe tool activity without allowing a running agent to replace the user's panel choice. */
export function reduceScreenActivity(previous: ScreenActivityState, input: {
  runKey: string | null
  running: boolean
  computerId: string | null
  browserSequence: number | null
}): { state: ScreenActivityState; reveal: ScreenKind | null } {
  const computerChanged = input.computerId !== null && input.computerId !== previous.computerId
  const browserChanged = input.browserSequence !== null && input.browserSequence !== previous.browserSequence
  const latest = computerChanged ? 'computer' : browserChanged ? 'browser' : previous.latest
  const newRun = input.running && input.runKey !== previous.runKey
  const revealed = newRun ? false : previous.revealed
  const reveal = input.running && !revealed && (computerChanged || browserChanged) ? latest : null
  const state: ScreenActivityState = {
    runKey: input.running ? input.runKey : previous.runKey,
    computerId: input.computerId,
    browserSequence: input.browserSequence,
    revealed: revealed || reveal !== null,
    latest,
  }
  if ((Object.keys(state) as Array<keyof ScreenActivityState>).every(key => state[key] === previous[key])) {
    return { state: previous, reveal: null }
  }
  return { state, reveal }
}
