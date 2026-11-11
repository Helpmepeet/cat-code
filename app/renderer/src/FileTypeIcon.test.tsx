import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileTypeIcon, type FileIconRenderKind } from './FileTypeIcon.js'

const fileIconType = (path: string, renderKind?: FileIconRenderKind) => renderToStaticMarkup(<FileTypeIcon path={path} renderKind={renderKind} />).match(/data-type="([^"]+)"/)?.[1]

test('file types follow render kind first and cover approved categories', () => {
  for (const [path, type] of [['page.html', 'web'], ['README.md', 'doc'], ['report.pdf', 'pdf'], ['art.svg', 'image'], ['photo.webp', 'image'], ['data.csv', 'table'], ['data.tsv', 'table'], ['data.xlsx', 'table'], ['source.tsx', 'code']]) expect(fileIconType(path!)).toBe(type)
  expect(fileIconType('page.html', 'text')).toBe('code')
  expect(fileIconType('extensionless', 'markdown')).toBe('doc')
  expect(fileIconType('component.mdx')).toBe('code')
  for (const extension of ['avif', 'bmp', 'ico']) expect(fileIconType(`image.${extension}`)).toBe('code')
  expect(fileIconType('/repo/page.html:12:3')).toBe('web')
  expect(fileIconType('/repo/README.md:42')).toBe('doc')
  expect(fileIconType('/repo/data.csv:12:3')).toBe('table')
  expect(fileIconType('/repo/data.tsv:12', 'text')).toBe('code')
  expect(renderToStaticMarkup(<FileTypeIcon path="page.html" />)).toContain('M3 9h18')
  expect(renderToStaticMarkup(<FileTypeIcon path="page.html" />)).not.toContain('<circle')
})
