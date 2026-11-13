import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TRANSCRIPT_REHYPE_PLUGINS } from './markdownPlugins.js'
import { mergeMountedMarkdownLeaves, planMarkdownLeaves, renderMarkdownTree } from './markdownRenderPlan.js'

const options = { rehypePlugins: TRANSCRIPT_REHYPE_PLUGINS, math: true, recognizeCallouts: true }

// HAST includes the fence's final newline in the highlighting budget.
for (const characters of [16_000, 16_001, 512 * 1024]) {
  test(`completed JavaScript fence with ${characters} characters preserves text across repeated planning`, () => {
    const prefix = 'const value = "<script>&</script>";\n'
    const body = prefix + ' '.repeat(characters - prefix.length - 1)
    const source = '```javascript\n' + body + '\n```'
    for (let attempt = 0; attempt < 2; attempt++) {
      // No component-local plan cache, as on a remount.
      const leaves = planMarkdownLeaves(`remount-${attempt}`, source, options)
      const code = leaves.filter(leaf => leaf.kind === 'code')
      expect(code.length).toBeGreaterThan(0)
      expect(code.every(leaf => leaf.codeSource === body)).toBe(true)
      expect(code.every(leaf => leaf.codeLanguage === 'javascript')).toBe(true)
      const units = mergeMountedMarkdownLeaves(leaves, 0, leaves.length)
      expect(units).toHaveLength(1)
      const html = renderToStaticMarkup(renderMarkdownTree(units[0].tree))
      expect(html).toContain('&lt;script&gt;&amp;&lt;/script&gt;')
      expect(html).not.toContain('<script>')
      if (characters <= 16_000) {
        expect(html).toContain('hljs-keyword')
        expect(html).toContain('hljs-string')
      } else {
        expect(html).not.toContain('hljs')
        expect(html).not.toContain('<span')
        // The plain fallback contains no syntax elements, and loses no text.
        expect(html.replace(/<[^>]*>/g, '')).toBe((body + '\n')
          .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;'))
      }
    }
  })
}
