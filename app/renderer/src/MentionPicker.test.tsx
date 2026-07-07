import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  filterMentionItems,
  MentionPicker,
  type MentionItem,
} from './MentionPicker.js'

const items: MentionItem[] = [
  { label: 'src/auth/auth.ts', mono: true },
  { label: 'src/auth/middleware.ts', mono: true },
  { label: 'package.json', mono: true },
]

test('filter is a case-insensitive substring match on the label', () => {
  expect(filterMentionItems(items, 'AUTH').map(i => i.label)).toEqual([
    'src/auth/auth.ts',
    'src/auth/middleware.ts',
  ])
})

test('an empty or whitespace query returns every item unchanged', () => {
  expect(filterMentionItems(items, '')).toHaveLength(3)
  expect(filterMentionItems(items, '   ')).toHaveLength(3)
})

test('a non-matching query yields an empty list', () => {
  expect(filterMentionItems(items, 'zzz')).toEqual([])
})

test('the picker renders filtered items and is data-source-agnostic', () => {
  const html = renderToStaticMarkup(
    <MentionPicker
      open
      query="auth"
      items={items}
      onPick={() => {}}
    />,
  )
  expect(html).toContain('src/auth/auth.ts')
  expect(html).toContain('src/auth/middleware.ts')
  expect(html).not.toContain('package.json')
})

test('the picker shows an empty state when nothing matches', () => {
  const html = renderToStaticMarkup(
    <MentionPicker open query="zzz" items={items} onPick={() => {}} />,
  )
  expect(html).toContain('No matches')
})

test('a closed picker renders nothing', () => {
  const html = renderToStaticMarkup(
    <MentionPicker open={false} query="" items={items} onPick={() => {}} />,
  )
  expect(html).toBe('')
})

test('optional tabs render a source switcher', () => {
  const html = renderToStaticMarkup(
    <MentionPicker
      open
      query=""
      items={items}
      onPick={() => {}}
      tabs={[
        { id: 'files', label: 'Files' },
        { id: 'agents', label: 'Agents' },
      ]}
      activeTab="files"
    />,
  )
  expect(html).toContain('Files')
  expect(html).toContain('Agents')
})
