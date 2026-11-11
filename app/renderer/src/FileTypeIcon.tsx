import { filePreviewKind } from '../../shared/filePreview.js'
import './fileTypeIcon.css'

export type FileIconRenderKind = 'html' | 'localhost' | 'markdown' | 'pdf' | 'image' | 'svg' | 'xlsx' | 'table' | 'text'
function fileIconType(path: string, renderKind?: FileIconRenderKind) {
  const inferred = filePreviewKind(path)
  const kind = renderKind ?? (inferred === 'text' && /\.(?:csv|tsv)(?::\d+(?::\d+)?)?$/i.test(path) ? 'table' : inferred)
  if (kind === 'html' || kind === 'localhost') return 'web'
  if (kind === 'markdown') return 'doc'
  if (kind === 'pdf') return 'pdf'
  if (kind === 'image' || kind === 'svg') return 'image'
  if (kind === 'table' || kind === 'xlsx') return 'table'
  return 'code'
}
const paths = {
  web: 'M3 9h18',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  pdf: 'M9 2h7l4 4v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM16 2v4h4M4 7v13a2 2 0 0 0 2 2h9',
  image: 'M21 15l-5-5-9 10', table: 'M3 10h18M3 15h18M10 4v16', code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
}
export function FileTypeIcon({ path, renderKind }: { path: string; renderKind?: FileIconRenderKind }) {
  const type = fileIconType(path, renderKind)
  return <span className="file-type-icon" data-type={type} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {type === 'web' || type === 'image' || type === 'table' ? <rect x="3" y="4" width="18" height="16" rx="2" /> : null}
    {type === 'image' ? <circle cx="8.5" cy="9.5" r="1.5" /> : null}<path d={paths[type]} />
  </svg></span>
}
