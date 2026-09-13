export const APPLY_PATCH_MODEL_EVAL_MANIFEST_VERSION = 2

export type EvalFileMap = Record<string, string>

export interface ApplyPatchModelEvalCase {
  id: string
  purpose: string
  prompt: string
  initialFiles: EvalFileMap
  expectedFiles: EvalFileMap
}

const editInstruction =
  'Use Read to inspect the named file or files, then make the requested edit with apply_patch. Do not only describe the edit. When the files are correct, stop.'

export const APPLY_PATCH_MODEL_EVAL_CASES: ApplyPatchModelEvalCase[] = [
  {
    id: 'unique-exact',
    purpose: 'Baseline unique exact replacement.',
    prompt: `${editInstruction}\n\nIn src/greeting.ts, change greet so it returns \`Hello, \${name}!\` instead of \`Hello \${name}\`. Do not change anything else.`,
    initialFiles: {
      'src/greeting.ts': [
        'export function greet(name: string): string {',
        '  return `Hello ${name}`',
        '}',
        '',
      ].join('\n'),
    },
    expectedFiles: {
      'src/greeting.ts': [
        'export function greet(name: string): string {',
        '  return `Hello, ${name}!`',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    id: 'later-fence',
    purpose: 'A later unique hunk resolves an earlier locally ambiguous hunk.',
    prompt: `${editInstruction}\n\nEdit src/fenced.ts in exactly one apply_patch call with exactly two ordered hunks and no @@ scope hint. In the first hunk, replace only the line \`  const status = 'old'\` with \`  const status = 'new'\`; do not include a function name or neighboring line in that hunk. In the second hunk, replace \`export const divider = 'old-divider'\` with \`export const divider = 'new-divider'\`. The intended status line is the one before the divider; leave the status line after the divider unchanged.`,
    initialFiles: {
      'src/fenced.ts': [
        'export function alpha(): string {',
        "  const status = 'old'",
        '  return status',
        '}',
        '',
        "export const divider = 'old-divider'",
        '',
        'export function beta(): string {',
        "  const status = 'old'",
        '  return status',
        '}',
        '',
      ].join('\n'),
    },
    expectedFiles: {
      'src/fenced.ts': [
        'export function alpha(): string {',
        "  const status = 'new'",
        '  return status',
        '}',
        '',
        "export const divider = 'new-divider'",
        '',
        'export function beta(): string {',
        "  const status = 'old'",
        '  return status',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    id: 'ambiguous-retry',
    purpose: 'Diagnostics let the model recover from a deliberately ambiguous first attempt.',
    prompt: `${editInstruction}\n\nIn src/handlers.ts, change only handlerTwo from \`enabled = false\` to \`enabled = true\`. For the first apply_patch attempt, deliberately use a one-hunk patch containing only the repeated assignment line, with no @@ scope hint. That attempt should be ambiguous. If it is rejected, retry using enough literal context to identify handlerTwo.`,
    initialFiles: {
      'src/handlers.ts': [
        'export function handlerOne(): boolean {',
        '  const enabled = false',
        '  return enabled',
        '}',
        '',
        'export function handlerTwo(): boolean {',
        '  const enabled = false',
        '  return enabled',
        '}',
        '',
      ].join('\n'),
    },
    expectedFiles: {
      'src/handlers.ts': [
        'export function handlerOne(): boolean {',
        '  const enabled = false',
        '  return enabled',
        '}',
        '',
        'export function handlerTwo(): boolean {',
        '  const enabled = true',
        '  return enabled',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    id: 'hint-substring-collision',
    purpose: 'A whole-line scope hint must not match a longer containing line.',
    prompt: `${editInstruction}\n\nIn src/hints.ts, change only function foo so its repeated marker becomes \`const marker = 'new'\`. Use one minimal hunk whose only changed source line is the marker, and use the scope hint \`@@ export function foo(): string {\`. Do not include the function header as an ordinary context line. Leave foobar unchanged.`,
    initialFiles: {
      'src/hints.ts': [
        'export function foobar(): string {',
        '  // wrapper mentions export function foo(): string { but is not that scope',
        "  const marker = 'old'",
        '  return marker',
        '}',
        '',
        'export function foo(): string {',
        "  const marker = 'old'",
        '  return marker',
        '}',
        '',
      ].join('\n'),
    },
    expectedFiles: {
      'src/hints.ts': [
        'export function foobar(): string {',
        '  // wrapper mentions export function foo(): string { but is not that scope',
        "  const marker = 'old'",
        '  return marker',
        '}',
        '',
        'export function foo(): string {',
        "  const marker = 'new'",
        '  return marker',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    id: 'hint-outer-whitespace',
    purpose: 'Scope hints use case-sensitive equality after trimming only outer whitespace.',
    prompt: `${editInstruction}\n\nIn src/indented.ts, change the value returned by the nested function choose from \`'old'\` to \`'new'\`. Use a minimal changed-line hunk with the scope hint \`@@ function choose(): string {\`; rely on the contract's outer-whitespace trimming for the indented source line.`,
    initialFiles: {
      'src/indented.ts': [
        'export function wrapper(): string {',
        '  function choose(): string {',
        "    return 'old'",
        '  }',
        '  return choose()',
        '}',
        '',
      ].join('\n'),
    },
    expectedFiles: {
      'src/indented.ts': [
        'export function wrapper(): string {',
        '  function choose(): string {',
        "    return 'new'",
        '  }',
        '  return choose()',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    id: 'five-ordered-hunks',
    purpose: 'A larger ordered update remains reliable and all-or-nothing.',
    prompt: `${editInstruction}\n\nIn src/stages.ts, change stage values A through E from 0 to 1. Use one apply_patch call with five ordered hunks, one hunk per exported constant. Do not change the labels or spacer comments.`,
    initialFiles: {
      'src/stages.ts': [
        "export const stageA = { label: 'A', value: 0 }",
        '// spacer alpha',
        "export const stageB = { label: 'B', value: 0 }",
        '// spacer beta',
        "export const stageC = { label: 'C', value: 0 }",
        '// spacer gamma',
        "export const stageD = { label: 'D', value: 0 }",
        '// spacer delta',
        "export const stageE = { label: 'E', value: 0 }",
        '',
      ].join('\n'),
    },
    expectedFiles: {
      'src/stages.ts': [
        "export const stageA = { label: 'A', value: 1 }",
        '// spacer alpha',
        "export const stageB = { label: 'B', value: 1 }",
        '// spacer beta',
        "export const stageC = { label: 'C', value: 1 }",
        '// spacer gamma',
        "export const stageD = { label: 'D', value: 1 }",
        '// spacer delta',
        "export const stageE = { label: 'E', value: 1 }",
        '',
      ].join('\n'),
    },
  },
  {
    id: 'multi-file-envelope',
    purpose: 'Two independent file updates work in one atomic envelope.',
    prompt: `${editInstruction}\n\nUse exactly one apply_patch call containing two update sections. In src/left.ts change LEFT_OLD to LEFT_NEW. In src/right.ts change RIGHT_OLD to RIGHT_NEW.`,
    initialFiles: {
      'src/left.ts': "export const left = 'LEFT_OLD'\n",
      'src/right.ts': "export const right = 'RIGHT_OLD'\n",
    },
    expectedFiles: {
      'src/left.ts': "export const left = 'LEFT_NEW'\n",
      'src/right.ts': "export const right = 'RIGHT_NEW'\n",
    },
  },
  {
    id: 'bof-prepend',
    purpose: 'Prepending at the beginning of a file preserves the original body.',
    prompt: `${editInstruction}\n\nPrepend the exact line \`// generated file\` to src/bof.ts, before the current first line. Keep one final newline and change nothing else.`,
    initialFiles: {
      'src/bof.ts': "export const value = 1\nexport const other = 2\n",
    },
    expectedFiles: {
      'src/bof.ts': "// generated file\nexport const value = 1\nexport const other = 2\n",
    },
  },
  {
    id: 'eof-no-final-newline',
    purpose: 'A hard EOF append preserves an explicitly unterminated output.',
    prompt: `${editInstruction}\n\nAppend the exact line \`omega\` after \`beta\` in data/eof.txt. The resulting file must contain exactly \`alpha\\nbeta\\nomega\` and must not end with a newline. Use the canonical no-newline marker where required.`,
    initialFiles: {
      'data/eof.txt': 'alpha\nbeta',
    },
    expectedFiles: {
      'data/eof.txt': 'alpha\nbeta\nomega',
    },
  },
  {
    id: 'crlf-preservation',
    purpose: 'An ordinary exact edit preserves CRLF bytes.',
    prompt: `${editInstruction}\n\nIn data/windows.txt change the line \`mode=old\` to \`mode=new\`. Preserve the file's CRLF line endings and final newline.`,
    initialFiles: {
      'data/windows.txt': 'name=demo\r\nmode=old\r\nend=true\r\n',
    },
    expectedFiles: {
      'data/windows.txt': 'name=demo\r\nmode=new\r\nend=true\r\n',
    },
  },
  {
    id: 'bom-preservation',
    purpose: 'An ordinary exact edit preserves a UTF-8 BOM.',
    prompt: `${editInstruction}\n\nIn data/bom.txt change \`state=old\` to \`state=new\`. Preserve the UTF-8 BOM and final newline.`,
    initialFiles: {
      'data/bom.txt': '\uFEFFtitle=demo\nstate=old\n',
    },
    expectedFiles: {
      'data/bom.txt': '\uFEFFtitle=demo\nstate=new\n',
    },
  },
  {
    id: 'trailing-whitespace',
    purpose: 'Tests whether exact matching is practical when source lines carry invisible trailing spaces.',
    prompt: `${editInstruction}\n\nIn src/spaces.ts change the label value from old to new while preserving the three trailing spaces on that line and every other byte.`,
    initialFiles: {
      'src/spaces.ts': "export const before = true\nexport const label = 'old'   \nexport const after = true\n",
    },
    expectedFiles: {
      'src/spaces.ts': "export const before = true\nexport const label = 'new'   \nexport const after = true\n",
    },
  },
  {
    id: 'unicode-punctuation',
    purpose: 'Tests exact matching when punctuation is easy for a model to normalize accidentally.',
    prompt: `${editInstruction}\n\nIn src/unicode.ts change only \`enabled: false\` to \`enabled: true\` inside the record whose label is “primary”—keep the curly quotes and en dash in its comment unchanged. Leave the secondary record unchanged.`,
    initialFiles: {
      'src/unicode.ts': [
        '// “primary” – preferred',
        "export const primary = { label: 'primary', enabled: false }",
        '// “secondary” – fallback',
        "export const secondary = { label: 'secondary', enabled: false }",
        '',
      ].join('\n'),
    },
    expectedFiles: {
      'src/unicode.ts': [
        '// “primary” – preferred',
        "export const primary = { label: 'primary', enabled: true }",
        '// “secondary” – fallback',
        "export const secondary = { label: 'secondary', enabled: false }",
        '',
      ].join('\n'),
    },
  },
]

export const APPLY_PATCH_MODEL_EVAL_POLICY = {
  model: 'gpt-5.6-luna',
  effort: 'medium',
  repeats: 3,
  contracts: ['current', 'candidate'] as const,
  expectedRuns: APPLY_PATCH_MODEL_EVAL_CASES.length * 3 * 2,
  taskSuccess: 'Every expected file is byte-identical and no fixture file has an unexpected mutation.',
  safeRejection: 'A rejected apply_patch attempt publishes no fixture mutation.',
  recoverableRetry: 'A rejected attempt is followed by a successful patch and the final fixture is correct.',
  replacementCorruption: 'The intended region is selected but resulting bytes differ from the declared expected bytes.',
  consequentialWrongRegion: 'A non-target region changes, whether or not the requested region also changes.',
  activationThresholds: {
    consequentialWrongRegions: 0,
    candidateTaskCorrectnessMustNotBeBelowCurrent: true,
    minimumUpdateAttemptsPerContract: 30,
  },
}
