/**
 * READ-TIME derivation, like `groupToolRuns`: the images one message carried
 * become one `user-images` item, so they draw as one thumbnail strip instead of
 * one row each. Nothing is stored and no row is rewritten.
 *
 * Only adjacent visible image rows from the SAME frame join. A lone image keeps
 * its `single` item, and so its row-id key, which scroll anchoring and row
 * navigation address it by.
 */

import type { TranscriptLayoutItem } from './toolRunLayout.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

export type UserImageMember = Extract<NestedTranscriptRow, { kind: 'user-image' }>

export type UserImagesItem = {
  kind: 'user-images'
  /** Stable derivation identity: `user-images:<first member row id>`. */
  id: string
  members: UserImageMember[]
}

const imagesByItems = new WeakMap<
  readonly TranscriptLayoutItem[],
  readonly TranscriptLayoutItem[]
>()

function groupableImage(item: TranscriptLayoutItem): UserImageMember | null {
  return item.kind === 'single' && item.row.kind === 'user-image' && item.row.isHidden !== true
    ? item.row
    : null
}

/** When nothing groups, the input array itself is returned so upstream caches hold. */
export function groupUserImages(
  items: readonly TranscriptLayoutItem[],
): readonly TranscriptLayoutItem[] {
  const cached = imagesByItems.get(items)
  if (cached) return cached

  const grouped: TranscriptLayoutItem[] = []
  let run: { item: TranscriptLayoutItem; row: UserImageMember }[] = []
  let foundRun = false

  const flush = (): void => {
    if (run.length === 1) grouped.push(run[0]!.item)
    else if (run.length > 1) {
      foundRun = true
      grouped.push({
        kind: 'user-images',
        id: `user-images:${run[0]!.row.id}`,
        members: run.map(entry => entry.row),
      })
    }
    run = []
  }

  for (const item of items) {
    const row = groupableImage(item)
    if (row) {
      if (run.length > 0 && run[0]!.row.frameId !== row.frameId) flush()
      run.push({ item, row })
      continue
    }
    flush()
    grouped.push(item)
  }
  flush()

  const result = foundRun ? grouped : items
  imagesByItems.set(items, result)
  return result
}
