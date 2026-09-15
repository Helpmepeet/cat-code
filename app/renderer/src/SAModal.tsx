/**
 * P4-30 — `SAModal` + `saBtn` (`SessionActions.jsx:206-241`), the two shared
 * primitives the Export dialog is built from.
 *
 * Shared modal shell for session-action dialogs.
 *
 * Rebuilt on the P0-2 tokens and the house dialog idiom (`TasksDialog.tsx:100+`),
 * zero ported code, no inline `style` (the anchored menu's data-driven geometry
 * has no counterpart here — a modal is centred, so every value is static).
 * Tints are a STATIC map, never an interpolated arbitrary value: a
 * `bg-[${hex}]/10` silently no-ops under Tailwind v4 and the SSR harness cannot
 * see it (CLAUDE.md, the dynamic-class trap).
 */
import { useRef, type ReactNode, type Ref } from 'react'
import { ActionCloseIcon } from './SessionActionIcons.js'
import { useModalFocus } from './overlayFocus.js'

/** The header chip hue per dialog (`iconTint` blue | amber | pink). */
export type SAModalTint = 'info' | 'warn' | 'accent'

const TINT_CLASS: Record<SAModalTint, string> = {
  info: 'bg-tone-info/[0.11] text-tone-info',
  warn: 'bg-tone-warn/[0.11] text-tone-warn',
  accent: 'bg-accent/[0.11] text-accent',
}

/** `SAModal`'s two widths (`SessionActions.jsx:206` default 540, export 580). */
const WIDTH_CLASS = {
  default: 'w-[540px]',
  wide: 'w-[580px]',
} as const

export type SAModalProps = {
  icon: ReactNode
  tint: SAModalTint
  title: string
  subtitle?: string
  width?: keyof typeof WIDTH_CLASS
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/**
 * The dialog shell every consumer uses: the Escape listener plus the frame.
 *
 * The two halves are separate components on purpose. This package has no DOM
 * click harness, so a dismissal contract is only really provable by invoking a
 * HOOK-FREE component and reading the handler off its element (the
 * `WelcomeScreen.test.tsx` hook-free component convention). Keeping the
 * effect here leaves {@link SAModalFrame} hook-free and directly exercisable.
 */
export function SAModal(props: SAModalProps): ReactNode {
  const { onClose } = props
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalFocus({
    open: true,
    containerRef: dialogRef,
    onEscape: onClose,
  })

  return <SAModalFrame {...props} dialogRef={dialogRef} />
}

/** The presentation half of {@link SAModal}. Consumers use `SAModal`, not this. */
export function SAModalFrame({
  icon,
  tint,
  title,
  subtitle,
  width = 'default',
  onClose,
  children,
  footer,
  dialogRef,
}: SAModalProps & { dialogRef?: Ref<HTMLDivElement> }): ReactNode {
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-scrim p-6 backdrop-blur-[4px]"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={
          'animate-sa-pop flex max-h-[86vh] max-w-full flex-col overflow-hidden rounded-2xl border border-shell-seam bg-surface-raised shadow-[var(--elev-modal)] ' +
          WIDTH_CLASS[width]
        }
        // The card is not the scrim: a click inside it must not dismiss.
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-shell-seam px-5 pb-3.5 pt-[18px]">
          <span
            className={
              'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] ' +
              TINT_CLASS[tint]
            }
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-[-0.01em] text-text-primary">
              {title}
            </div>
            {subtitle ? (
              <div className="mt-0.5 truncate text-[12.5px] text-text-subtle">
                {subtitle}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-text-subtle transition-colors hover:bg-white/[0.06] hover:text-text-primary"
          >
            <ActionCloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {children}
        </div>

        {footer ? (
          <div className="flex items-center justify-end gap-2.5 border-t border-shell-seam bg-white/[0.015] px-5 py-[13px]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** `saBtn`'s variants (`SessionActions.jsx:233-241`). */
export type SAButtonVariant = 'secondary' | 'primary' | 'danger' | 'danger-primary'

const BUTTON_CLASS: Record<SAButtonVariant, string> = {
  secondary: 'border-shell-seam bg-transparent text-text-muted hover:text-text-primary',
  primary: 'border-transparent bg-accent text-on-fill hover:opacity-90',
  danger: 'border-tone-danger/30 bg-transparent text-tone-danger hover:bg-tone-danger/10',
  'danger-primary': 'border-transparent bg-tone-danger text-on-fill hover:opacity-90',
}

/**
 * A dialog action-bar button. `disabled` renders the prototype's inert variant
 * (flat wash + ghost text) and `reason` explains it, which is how the rest of
 * this surface handles an unreachable affordance (`SessionActionsMenu.tsx`
 * `MenuRow`) rather than hiding it.
 *
 * `reason` reaches the user three ways, because a bare `title` reaches only a
 * hovering mouse: the optional `marker` is a VISIBLE tag (the `soon` idiom
 * `MenuRow` pairs with its own tooltip), `title` is the hover text, and the
 * accessible name carries the reason for anyone not using either.
 */
export function SAButton({
  label,
  onClick,
  variant = 'secondary',
  disabled = false,
  reason,
  marker,
}: {
  label: string
  onClick?: () => void
  variant?: SAButtonVariant
  disabled?: boolean
  reason?: string
  /** Short visible state tag shown beside the label while disabled (e.g. `soon`). */
  marker?: string
}): ReactNode {
  const explained = disabled && reason !== undefined
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...(explained ? { title: reason, 'aria-label': `${label}, ${reason}` } : {})}
      className={
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-[15px] py-2 text-[12.5px] font-semibold transition-all ' +
        (disabled
          ? 'cursor-default border-shell-seam bg-white/[0.04] text-text-ghost opacity-60'
          : BUTTON_CLASS[variant])
      }
    >
      {label}
      {disabled && marker ? (
        <span className="text-[9.5px] font-semibold uppercase tracking-wide">
          {marker}
        </span>
      ) : null}
    </button>
  )
}
