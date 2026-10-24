type ReadRowOffset = (key: string) => number | null

const virtualRows = new WeakMap<HTMLElement, ReadRowOffset>()

/** The top-level virtual list knows offsets even for rows it has unmounted. */
export function registerTranscriptRowOffsets(scroller: HTMLElement, readOffset: ReadRowOffset): () => void {
  virtualRows.set(scroller, readOffset)
  return () => {
    if (virtualRows.get(scroller) === readOffset) virtualRows.delete(scroller)
  }
}

export function readTranscriptRowOffset(scroller: HTMLElement, key: string): number | null {
  return virtualRows.get(scroller)?.(key) ?? null
}
