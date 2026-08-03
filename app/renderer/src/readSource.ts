/**
 * The file-READ card's source model: the engine's `cat -n` payload split back
 * into line numbers and the source they belong to, plus the language the source
 * is in.
 *
 * WHY IT EXISTS. A read result reaches the renderer already numbered.
 * `FileReadTool` returns `addLineNumbers(file)` (`src/tools/FileReadTool/
 * FileReadTool.ts:721`), which prefixes every line with `N\t` (compact, the
 * default) or a right-aligned `N→` when the compact killswitch is on
 * (`src/utils/file.ts:290-318`); its prompt states the contract to the model
 * (`src/tools/FileReadTool/prompt.ts:15` "cat -n format"). The projector passes
 * that string through untouched. The card was drawing a SECOND gutter over it,
 * so a read painted two columns of numbers, and the card's own column was the
 * wrong one on any `offset` read because it always restarted at 1 while the
 * engine's carried the file's true lines. The embedded prefix also meant the
 * body could not be syntax-colored: a highlighter fed `4\texport async …`
 * tokenizes the line number as part of the code.
 *
 * So stripping the prefix is what lets the gutter tell the truth AND leaves a
 * clean source string to color. Both behaviours are gated on recognising the
 * format: content that is not the engine's numbered shape (an error string, a
 * tool whose result is prose) keeps the plain, positionally-numbered rendering
 * it has always had.
 *
 * The parse mirrors the engine's own inverse, `stripLineNumberPrefix`
 * (`src/utils/file.ts:325-328`); it is restated here rather than imported
 * because the renderer takes no runtime dependency on the engine graph.
 */

/** `N\t` or `N→`, the two shapes `addLineNumbers` emits. */
const NUMBERED_LINE = /^\s*(\d+)[→\t](.*)$/

export type ReadSource = {
  /** The source, one entry per line, with any engine number prefix removed. */
  lines: string[]
  /**
   * The file line number of each entry, or null when the content was not the
   * engine's numbered shape and the caller must fall back to counting.
   */
  numbers: number[] | null
}

/**
 * Split a read result into source and line numbers.
 *
 * Every line must carry a prefix and the numbers must run consecutively, so a
 * plain output that merely happens to open with digits and a tab cannot be
 * mistaken for a numbered read.
 */
export function parseReadSource(content: string): ReadSource {
  const raw = content.split('\n')
  const numbers: number[] = []
  const lines: string[] = []
  for (const line of raw) {
    const match = NUMBERED_LINE.exec(line)
    if (match === null) return { lines: raw, numbers: null }
    const number = Number(match[1])
    const previous = numbers[numbers.length - 1]
    if (previous !== undefined && number !== previous + 1) {
      return { lines: raw, numbers: null }
    }
    numbers.push(number)
    lines.push(match[2] ?? '')
  }
  if (numbers.length === 0) return { lines: raw, numbers: null }
  return { lines, numbers }
}

/**
 * The gutter for `count` lines starting at `startIndex`. Real file numbers when
 * the read was numbered; otherwise the positional count the card drew before,
 * so an unrecognised payload renders exactly as it used to.
 */
export function readLineNumbers(
  source: ReadSource,
  startIndex: number,
  count: number,
): number[] {
  if (source.numbers === null) {
    return Array.from({ length: count }, (_, index) => startIndex + index + 1)
  }
  return source.numbers.slice(startIndex, startIndex + count)
}

/**
 * File extension → highlight.js language.
 *
 * Only names highlight.js registers in its `common` bundle, which is what
 * `rehype-highlight` loads: an unregistered name would silently render
 * uncolored (`ignoreMissing`), which is the same as not mapping it, so mapping
 * one would only be a claim we cannot keep. `.toml` → `ini` is the one
 * approximation, and it is the shape TOML actually shares (`[section]` headers
 * over `key = value`).
 */
const SOURCE_LANGUAGES: Readonly<Record<string, string>> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  diff: 'diff',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  htm: 'xml',
  html: 'xml',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lua: 'lua',
  m: 'objectivec',
  markdown: 'markdown',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  patch: 'diff',
  php: 'php',
  pl: 'perl',
  py: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

/**
 * The language of the file a read card is showing, or null when the path is
 * missing or its extension is not one we can color. Reads the raw tool input,
 * so it narrows `unknown` rather than trusting a cast.
 */
export function readSourceLanguage(filePath: unknown): string | null {
  if (typeof filePath !== 'string') return null
  const name = filePath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  // `<= 0` also drops dotfiles ('.gitignore'), which have no extension to read.
  if (dot <= 0) return null
  return SOURCE_LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * Wrap source in a markdown fence for the highlighter.
 *
 * The fence has to be longer than the longest backtick run in the file, or a
 * file that itself contains a fence (every markdown document in this repo)
 * would close the block early and render its own tail as prose.
 */
export function sourceFence(code: string, lang: string): string {
  let longest = 0
  for (const run of code.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length)
  }
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${code}\n${fence}`
}
