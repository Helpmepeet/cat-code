/**
 * Shared renderer path helpers. `basename` was copied inline across the shell
 * surfaces (Sidebar / TabBar / WorkspacePanels / debugStateReport); this is the
 * single source of truth. Handles POSIX and Windows separators and trims any
 * trailing slashes ('/a/b/' → 'b'); returns '' for a root/empty path.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] ?? ''
}
