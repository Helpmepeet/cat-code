import type { MentionItem } from './MentionPicker.js'

export function filterMentionItems(
  items: readonly MentionItem[],
  query: string,
): MentionItem[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return [...items]
  return items.filter(item => item.label.toLowerCase().includes(q))
}
