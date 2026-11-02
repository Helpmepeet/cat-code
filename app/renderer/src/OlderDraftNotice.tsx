// Drafts that cannot be persisted (too long, over the saved-draft cap, storage
// refused) get no warning: the user found a composer banner about an unsaved
// draft more disruptive than the rare loss it guarded against. Only a restore
// that brought back an older copy is mentioned, since the text differs from
// what the user last typed.
export function OlderDraftNotice({ show }: { show: boolean }) {
  return show ? (
    <p role="status" aria-label="Older draft restored" className="mx-1 mb-2 text-[11px] text-text-subtle">
      Restored an older copy. Your last changes to this draft were not saved.
    </p>
  ) : null
}
