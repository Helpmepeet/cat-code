export function EmptyState({
  description,
  title,
}: {
  description?: string
  title: string
}) {
  return (
    <div className="py-14 text-center">
      <div className="mb-1 text-sm font-medium text-text-subtle">{title}</div>
      {description ? <div className="text-xs text-text-subtle/75">{description}</div> : null}
    </div>
  )
}
