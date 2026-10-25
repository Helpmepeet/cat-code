import { useContext, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ACCENT_KEYS, ACCENT_LABELS, ACCENT_SWATCH_CLASS, AccentThemeContext, DEFAULT_ACCENT } from './accentTheme.js'
import { COLOR_SCHEME_KEYS, COLOR_SCHEME_LABELS, ColorSchemeContext, DEFAULT_COLOR_SCHEME } from './colorScheme.js'
import { CODE_THEME_KEYS, CODE_THEME_LABELS, CodeThemeContext, DEFAULT_CODE_THEME } from './codeTheme.js'
import { DEFAULT_GLASS_ENABLED, GlassModeContext } from './glassMode.js'
import { DEFAULT_PROSE_ARRIVAL, PROSE_ARRIVALS, PROSE_ARRIVAL_LABELS, ProseArrivalContext } from './proseArrival.js'
import { DEFAULT_REASONING_LAYOUT, REASONING_LAYOUT_MODES, ReasoningLayoutContext } from './reasoningLayout.js'
import { DEFAULT_TOOL_CARD_STYLE, TOOL_CARD_STYLES, TOOL_CARD_STYLE_LABELS, ToolCardStyleContext } from './toolCardStyle.js'
import { DEFAULT_TOOLS_EXPANDED, ToolsExpandedContext } from './toolsExpanded.js'
import { DEFAULT_TRANSCRIPT_MODE, TRANSCRIPT_MODES, TRANSCRIPT_MODE_LABELS, TranscriptModeContext } from './transcriptMode.js'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../shared/notificationPreferences.js'
import { NotificationPreferencesContext } from './notificationPreferences.js'
import { ToggleSwitch } from './SettingsEditors.js'
import { ConversationAppearancePreview } from './ConversationAppearancePreview.js'
import './appearanceSettings.css'

function ChoiceGroup<T extends string>({
  label, options, value, onChange, children, optionLabels, className = 'appearance-segments',
}: {
  label: string
  options: readonly T[]
  value: T
  onChange: (value: T) => void
  children: (value: T) => ReactNode
  optionLabels?: Readonly<Record<T, string>>
  className?: string
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!offset && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (options.indexOf(value) + offset + options.length) % options.length
    onChange(options[index]!)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus()
  }
  return (
    <div aria-label={label} className={className} data-setting-control onKeyDown={onKeyDown} role="radiogroup">
      {options.map(option => (
        <button
          aria-checked={value === option}
          aria-label={optionLabels?.[option]}
          key={option}
          onClick={() => onChange(option)}
          role="radio"
          tabIndex={value === option ? 0 : -1}
          type="button"
          value={option}
        >
          {children(option)}
        </button>
      ))}
    </div>
  )
}

function Section({ title, modified, onReset, children }: {
  title: string
  modified: boolean
  onReset: () => void
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="appearance-section">
      <div className="appearance-section-heading">
        <h3>{title}</h3>
        {modified ? <button aria-label={`Restore ${title.toLowerCase()} defaults`} className="appearance-reset" onClick={onReset} type="button">Restore defaults</button> : null}
      </div>
      {children}
    </section>
  )
}

function MiniatureWindow({ scheme, split }: { scheme: 'light' | 'dark'; split?: boolean }) {
  return (
    <span aria-hidden className={`appearance-mini appearance-mini-${scheme}${split ? ' appearance-mini-split' : ''}`}>
      <span className="appearance-mini-sidebar"><i /><i /><i /><i /></span>
      <span className="appearance-mini-bubble" />
      <span className="appearance-mini-line appearance-mini-line-first" />
      <span className="appearance-mini-line appearance-mini-line-second" />
      <span className="appearance-mini-composer" />
    </span>
  )
}

export function AppearanceSettings() {
  const { scheme, appearance, setScheme } = useContext(ColorSchemeContext)
  const { accent, setAccent } = useContext(AccentThemeContext)
  const { glass, setGlass } = useContext(GlassModeContext)
  const { arrival, setArrival } = useContext(ProseArrivalContext)
  const { style, setStyle } = useContext(ToolCardStyleContext)
  const { expanded, setExpanded } = useContext(ToolsExpandedContext)
  const { mode, setMode } = useContext(ReasoningLayoutContext)
  const { mode: transcriptMode, setMode: setTranscriptMode } = useContext(TranscriptModeContext)
  const { theme, setTheme } = useContext(CodeThemeContext)
  const { preferences, setPreferences } = useContext(NotificationPreferencesContext)
  const [replay, setReplay] = useState(0)

  return (
    <div className="appearance-settings">
      <Section title="Window" modified={scheme !== DEFAULT_COLOR_SCHEME || accent !== DEFAULT_ACCENT || glass !== DEFAULT_GLASS_ENABLED} onReset={() => {
        setScheme(DEFAULT_COLOR_SCHEME)
        setAccent(DEFAULT_ACCENT)
        setGlass(DEFAULT_GLASS_ENABLED)
      }}>
        <div data-setting-key="scheme" tabIndex={-1}>
          <ChoiceGroup className="appearance-schemes" label="Appearance" optionLabels={COLOR_SCHEME_LABELS} options={COLOR_SCHEME_KEYS} value={scheme} onChange={setScheme}>
            {key => <>
              <span className="appearance-scheme-art">
                {key === 'system' ? <><MiniatureWindow scheme="light" split /><MiniatureWindow scheme="dark" split /></> : <MiniatureWindow scheme={key} />}
              </span>
              <span className="appearance-scheme-label">{COLOR_SCHEME_LABELS[key]}{key === 'system' && scheme === 'system' ? <span className="appearance-scheme-now">{appearance === 'dark' ? 'Dark now' : 'Light now'}</span> : null}</span>
            </>}
          </ChoiceGroup>
        </div>
        <div className="appearance-window-rows">
          <div className="appearance-row" data-setting-key="accent" tabIndex={-1}>
            <span className="appearance-row-label">Accent</span>
            <ChoiceGroup className="appearance-swatches" label="Accent color" optionLabels={ACCENT_LABELS} options={ACCENT_KEYS} value={accent} onChange={setAccent}>
              {key => <span aria-label={ACCENT_LABELS[key]} className={`appearance-swatch ${ACCENT_SWATCH_CLASS[key]}`} title={ACCENT_LABELS[key]} />}
            </ChoiceGroup>
          </div>
          <div className="appearance-row" data-setting-key="glass" tabIndex={-1}>
            <span className="appearance-row-label">Frosted window</span>
            <div data-setting-control><ToggleSwitch label="Frosted window" value={glass} onChange={setGlass} /></div>
          </div>
        </div>
      </Section>
      <Section title="Notifications" modified={preferences.notify !== DEFAULT_NOTIFICATION_PREFERENCES.notify || preferences.dockBadge !== DEFAULT_NOTIFICATION_PREFERENCES.dockBadge} onReset={() => setPreferences({ ...DEFAULT_NOTIFICATION_PREFERENCES })}>
        <p className="appearance-section-description">Banners appear only while Cat Code is in the background.</p>
        <div className="appearance-controls">
          <div className="appearance-row" data-setting-key="notify" tabIndex={-1}>
            <span className="appearance-row-label">Notify</span>
            <ChoiceGroup label="Notify" options={['off', 'waiting', 'all'] as const} value={preferences.notify} onChange={notify => setPreferences({ ...preferences, notify })}>
              {key => key === 'off' ? 'Off' : key === 'waiting' ? 'Needs input' : 'All'}
            </ChoiceGroup>
          </div>
          <div className="appearance-row" data-setting-key="dockBadge" tabIndex={-1}>
            <span className="appearance-row-label">Dock badge</span>
            <div data-setting-control><ToggleSwitch label="Dock badge" value={preferences.dockBadge} onChange={dockBadge => setPreferences({ ...preferences, dockBadge })} /></div>
          </div>
        </div>
      </Section>
      <Section title="Conversation" modified={transcriptMode !== DEFAULT_TRANSCRIPT_MODE || arrival !== DEFAULT_PROSE_ARRIVAL || style !== DEFAULT_TOOL_CARD_STYLE || expanded !== DEFAULT_TOOLS_EXPANDED || mode !== DEFAULT_REASONING_LAYOUT || theme !== DEFAULT_CODE_THEME} onReset={() => {
        setTranscriptMode(DEFAULT_TRANSCRIPT_MODE)
        setArrival(DEFAULT_PROSE_ARRIVAL)
        setStyle(DEFAULT_TOOL_CARD_STYLE)
        setExpanded(DEFAULT_TOOLS_EXPANDED)
        setMode(DEFAULT_REASONING_LAYOUT)
        setTheme(DEFAULT_CODE_THEME)
        setReplay(value => value + 1)
      }}>
        <div className="appearance-controls">
          <div className="appearance-row" data-setting-key="transcriptMode" tabIndex={-1}>
            <span className="appearance-row-label">Transcript</span>
            <ChoiceGroup label="Transcript" options={TRANSCRIPT_MODES} value={transcriptMode} onChange={setTranscriptMode}>{key => TRANSCRIPT_MODE_LABELS[key]}</ChoiceGroup>
          </div>
          <div className="appearance-row" data-setting-key="arrival" tabIndex={-1}>
            <span className="appearance-row-label">Text arrival</span>
            <div className="appearance-row-controls">
              <button className="appearance-replay" onClick={() => setReplay(value => value + 1)} type="button">
                <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
                Replay
              </button>
              <ChoiceGroup label="Text arrival" options={PROSE_ARRIVALS} value={arrival} onChange={value => {
                setArrival(value)
                setReplay(value => value + 1)
              }}>{key => PROSE_ARRIVAL_LABELS[key]}</ChoiceGroup>
            </div>
          </div>
          <div className="appearance-row" data-setting-key="toolCardStyle" tabIndex={-1}>
            <span className="appearance-row-label">Tool calls</span>
            <div className="appearance-row-controls">
              <ChoiceGroup label="Tool call style" options={TOOL_CARD_STYLES} value={style} onChange={setStyle}>{key => TOOL_CARD_STYLE_LABELS[key]}</ChoiceGroup>
              <div className="appearance-tool-detail" data-setting-key="toolsExpanded" tabIndex={-1}>
                <ChoiceGroup label="Tool call detail" options={['collapsed', 'expanded']} value={expanded ? 'expanded' : 'collapsed'} onChange={value => setExpanded(value === 'expanded')}>{key => key === 'expanded' ? 'Expanded' : 'Collapsed'}</ChoiceGroup>
              </div>
            </div>
          </div>
          <div className="appearance-row" data-setting-key="reasoningLayout" tabIndex={-1}>
            <span className="appearance-row-label">Reasoning</span>
            <ChoiceGroup label="Reasoning layout" options={REASONING_LAYOUT_MODES} value={mode} onChange={setMode}>{key => key === 'trail' ? 'Trail' : 'Blocks'}</ChoiceGroup>
          </div>
          <div className="appearance-code-row" data-setting-key="codeTheme" tabIndex={-1}>
            <span className="appearance-row-label">Code theme</span>
            <ChoiceGroup className="appearance-themes" label="Code theme" optionLabels={CODE_THEME_LABELS} options={CODE_THEME_KEYS} value={theme} onChange={setTheme}>
              {key => <>
                <span>{CODE_THEME_LABELS[key]}</span>
                <span aria-hidden className="appearance-palette" data-code-theme={key}>
                  <i /><i /><i /><i /><i /><i />
                </span>
              </>}
            </ChoiceGroup>
          </div>
        </div>
        <ConversationAppearancePreview replay={replay} />
      </Section>
    </div>
  )
}
