/** A deliberately bounded POSIX local file URL, without URL-parser repairs. */
export function localFileUrlPath(value: string): string | null {
  if (value.length > 4_096 || /[\u0000-\u0020\u007f\\?#]/.test(value)) return null
  const match = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(value)
  if (!match || match[1]!.startsWith('//') || /%(?:2f|5c)/i.test(match[1]!)) return null
  try {
    const path = decodeURIComponent(match[1]!)
    return /[\0\r\n\\]/.test(path) ? null : path
  } catch {
    return null
  }
}
