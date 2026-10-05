/** Keep recurring disposable reads current while any Cat Code window is visible. */
export function createVisibilityGatedRefresh(
  run: () => Promise<unknown>,
  hasReadableWindow: () => boolean,
): {
  run: () => Promise<unknown>
  takeSkippedInterval: () => boolean
  allowNextRun: () => void
} {
  let coldRun = true
  let skippedInterval = false
  let forced = false
  return {
    run: async () => {
      if (forced) {
        forced = false
        coldRun = false
        skippedInterval = false
        return run()
      }
      if (coldRun) {
        coldRun = false
        return run()
      }
      if (!hasReadableWindow()) {
        skippedInterval = true
        return
      }
      skippedInterval = false
      return run()
    },
    takeSkippedInterval: () => {
      const skipped = skippedInterval
      skippedInterval = false
      return skipped
    },
    allowNextRun: () => { forced = true },
  }
}
