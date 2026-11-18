/** Paths reported by successful built-in mutations, never inferred from guest input. */
export function codeModeChangedFilePaths(toolName: string, result: unknown): string[] {
  if (!result || typeof result !== 'object') return []
  if (('omitted' in result && result.omitted === true) &&
      ['Edit', 'Write', 'NotebookEdit', 'apply_patch'].includes(toolName) &&
      'changedFilePaths' in result && Array.isArray(result.changedFilePaths)) {
    return result.changedFilePaths.filter((path): path is string => typeof path === 'string')
  }
  switch (toolName) {
    case 'Edit':
    case 'Write':
      return 'filePath' in result && typeof result.filePath === 'string' ? [result.filePath] : []
    case 'NotebookEdit':
      return 'notebook_path' in result && typeof result.notebook_path === 'string' ? [result.notebook_path] : []
    case 'apply_patch':
      return 'files' in result && Array.isArray(result.files)
        ? result.files.flatMap(file => typeof file?.path === 'string' ? [file.path] : [])
        : []
    default:
      return []
  }
}
