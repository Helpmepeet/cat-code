/** Complete the headless turn even if its final asynchronous SDK flush fails. */
export async function finalizeHeadlessRun(options: {
  flushInternalEvents(): Promise<void>
  goIdle(): void
  onError(error: unknown): Promise<void>
  release(): void
}): Promise<void> {
  try {
    await options.flushInternalEvents()
    options.goIdle()
  } catch (error) {
    await options.onError(error)
  } finally {
    options.release()
  }
}
