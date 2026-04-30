// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import * as React from 'react'
import { useState } from 'react'
import { Box, Text, color } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  getLayoutMode,
  formatWelcomeMessage,
  truncatePath,
  getLogoDisplayData,
} from '../../utils/logoV2Utils.js'
import { truncate } from '../../utils/format.js'
import { Clawd } from './Clawd.js'
import { getGlobalConfig } from 'src/utils/config.js'
import { resolveThemeSetting } from 'src/utils/systemTheme.js'
import { isDebugMode, isDebugToStdErr, getDebugLogPath } from 'src/utils/debug.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { getDumpPromptsPath } from 'src/services/api/dumpPrompts.js'
import { getStartupPerfLogPath, isDetailedProfilingEnabled } from 'src/utils/startupProfiler.js'
import { EmergencyTip } from './EmergencyTip.js'
import { VoiceModeNotice } from './VoiceModeNotice.js'
import { Opus1mMergeNotice } from './Opus1mMergeNotice.js'
import { feature } from 'bun:bundle'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import { useAppState } from '../../state/AppState.js'
import { getEffortSuffix } from '../../utils/effort.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { renderModelSetting } from '../../utils/model/model.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'
import { getDisplayPath } from '../../utils/file.js'
import { SMALL_MASCOTS } from './mascots.js'
import { Mascot } from './Mascot.js'
import { AccountsPanel } from './AccountsPanel.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const ChannelsNoticeModule =
  feature('KAIROS') || feature('KAIROS_CHANNELS')
    ? (require('./ChannelsNotice.js') as typeof import('./ChannelsNotice.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

function _temp(s: { agent: string | undefined }) {
  return s.agent
}
function _temp2(s: { effortValue: string | undefined }) {
  return s.effortValue
}

// ANSI Shadow "Cat Code" — pre-rendered, no runtime font file needed
const FIGLET_LINES = [
  ' ██████╗ █████╗ ████████╗     ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔══██╗╚══██╔══╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██║     ███████║   ██║       ██║     ██║   ██║██║  ██║█████╗  ',
  '██║     ██╔══██║   ██║       ██║     ██║   ██║██║  ██║██╔══╝  ',
  '╚██████╗██║  ██║   ██║       ╚██████╗╚██████╔╝██████╔╝███████╗',
  ' ╚═════╝╚═╝  ╚═╝   ╚═╝        ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
]
const FIGLET_WIDTH = Math.max(...FIGLET_LINES.map(l => stringWidth(l)))

const LABEL_WIDTH = 10

// Pastel theme — pink accent + white body text
const ACCENT_COLOR = '#F9B2D7' // pink — borders, figlet, headers, bullets
const TEXT_COLOR = '#FFFFFF' // white — body text

export function LogoV2() {
  const username = getGlobalConfig().oauthAccount?.displayName ?? ''
  const { columns } = useTerminalSize()
  const showSandboxStatus = SandboxManager.isSandboxingEnabled()
  const agent = useAppState(_temp)
  const effortValue = useAppState(_temp2)
  const config = getGlobalConfig()

  const [announcement] = useState(() => {
    const announcements = getInitialSettings().companyAnnouncements
    if (!announcements || announcements.length === 0) return undefined
    return config.numStartups === 1
      ? announcements[0]
      : announcements[Math.floor(Math.random() * announcements.length)]
  })

  const model = useMainLoopModel()
  const fullModelDisplayName = renderModelSetting(model)
  const { cwd, billingType, agentName: agentNameFromSettings } = getLogoDisplayData()
  const agentName = agent ?? agentNameFromSettings
  const effortSuffix = getEffortSuffix(model, effortValue)
  const modelDisplayName = truncate(fullModelDisplayName + effortSuffix, 30)

  const userTheme = resolveThemeSetting(config.theme)
  const compactBorderTitle = color('startupAccent', userTheme)(' Cat Code ')

  const layoutMode = getLayoutMode(columns)

  // Post-border notices (same across all layouts)
  const PostBorderNotices = (
    <>
      <VoiceModeNotice />
      <Opus1mMergeNotice />
      {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
      {isDebugMode() && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">Debug mode enabled</Text>
          <Text dimColor>Logging to: {isDebugToStdErr() ? 'stderr' : getDebugLogPath()}</Text>
        </Box>
      )}
      <EmergencyTip />
      {process.env.CLAUDE_CODE_TMUX_SESSION && (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>tmux session: {process.env.CLAUDE_CODE_TMUX_SESSION}</Text>
          <Text dimColor>
            {process.env.CLAUDE_CODE_TMUX_PREFIX_CONFLICTS
              ? `Detach: ${process.env.CLAUDE_CODE_TMUX_PREFIX} ${process.env.CLAUDE_CODE_TMUX_PREFIX} d (press prefix twice - Claude uses ${process.env.CLAUDE_CODE_TMUX_PREFIX})`
              : `Detach: ${process.env.CLAUDE_CODE_TMUX_PREFIX} d`}
          </Text>
        </Box>
      )}
      {announcement && (
        <Box paddingLeft={2} flexDirection="column">
          {!process.env.IS_DEMO && config.oauthAccount?.organizationName && (
            <Text dimColor>Message from {config.oauthAccount.organizationName}:</Text>
          )}
          <Text>{announcement}</Text>
        </Box>
      )}
      {showSandboxStatus && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">Your bash commands will be sandboxed. Disable with /sandbox.</Text>
        </Box>
      )}
      {false && !process.env.DEMO_VERSION && (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>Use /issue to report model behavior issues</Text>
        </Box>
      )}
      {false && !process.env.DEMO_VERSION && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">[ANT-ONLY] Logs:</Text>
          <Text dimColor>API calls: {getDisplayPath(getDumpPromptsPath())}</Text>
          <Text dimColor>Debug logs: {getDisplayPath(getDebugLogPath())}</Text>
          {isDetailedProfilingEnabled() && (
            <Text dimColor>Startup Perf: {getDisplayPath(getStartupPerfLogPath())}</Text>
          )}
        </Box>
      )}
    </>
  )

  // ── Compact mode (< 70 cols) ─────────────────────────────────────────────
  if (layoutMode === 'compact') {
    let welcomeMessage = formatWelcomeMessage(username)
    if (stringWidth(welcomeMessage) > columns - 4) {
      welcomeMessage = formatWelcomeMessage(null)
    }
    const cwdAvailableWidth = agentName
      ? columns - 4 - 1 - stringWidth(agentName) - 3
      : columns - 4
    const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))

    return (
      <>
        <OffscreenFreeze>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="startupAccent"
            borderText={{ content: compactBorderTitle, position: 'top', align: 'start', offset: 1 }}
            paddingX={1}
            paddingY={1}
            alignItems="center"
            width={columns}
          >
            <Text bold>{welcomeMessage}</Text>
            <Box marginY={1}><Clawd /></Box>
            <Text dimColor>{modelDisplayName}</Text>
            <Text dimColor>{agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd}</Text>
          </Box>
        </OffscreenFreeze>
        {PostBorderNotices}
      </>
    )
  }

  // ── Full startup screen ──────────────────────────────────────────────────
  // Layout: figlet title (top) + two columns: [cat | info+accounts]

  // Pick a small mascot, stable across re-renders
  const [seed] = useState(() => Math.random())
  const mascot = SMALL_MASCOTS[Math.floor(seed * SMALL_MASCOTS.length)]!

  const accent = ACCENT_COLOR
  const text = TEXT_COLOR

  // inner = columns minus the 2 border chars
  const inner = columns - 2

  // Layout: we want the vertical divider at the center of the inner width.
  // left half (cat box) = inner / 2
  // right half (info+accounts box) = inner - 1(divider) - left half
  // Cat is centered within left half; content is centered within right half.
  const halfInner = Math.floor(inner / 2)
  const leftCol = halfInner
  const rightCol = inner - 1 - leftCol
  const rightColContent = rightCol - 2 // minus paddingX=1 on each side
  // blockPad is 0 since we now fill the full inner width
  const blockPad = 0
  const contentBlockWidth = leftCol + 1 + rightCol

  // Figlet title: center within inner
  const figletPad = Math.max(0, Math.floor((inner - FIGLET_WIDTH) / 2))

  // Info content
  const welcomeMessage = formatWelcomeMessage(username)
  const modelLine = modelDisplayName
  const cwdAvailableWidth = agentName
    ? rightColContent - LABEL_WIDTH - 1 - stringWidth(agentName) - 3
    : rightColContent - LABEL_WIDTH - 1
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))

  // Compute left-padding to center the info block within the right box.
  // The widest info row determines the block's width.
  const truncatedModelLine = truncate(modelLine, rightColContent - LABEL_WIDTH)
  const infoBlockWidth = Math.max(
    stringWidth(welcomeMessage),
    LABEL_WIDTH + stringWidth(truncatedModelLine),
    LABEL_WIDTH + stringWidth(truncatedCwd),
    agentName ? LABEL_WIDTH + stringWidth(`@${agentName}`) : 0,
    LABEL_WIDTH + stringWidth('% shown is used'),
  )
  const infoLeftPad = Math.max(0, Math.floor((rightColContent - infoBlockWidth) / 2))

  return (
    <>
      <OffscreenFreeze>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={accent}
          width={columns}
        >
          {/* Figlet title */}
          <Box flexDirection="column" paddingY={1}>
            {FIGLET_LINES.map((line, i) => (
              <Text key={i} color={accent}>{' '.repeat(figletPad)}{line}</Text>
            ))}
          </Box>

          {/* Horizontal divider between figlet and content */}
          <Box
            borderStyle="single"
            borderColor={accent}
            borderDimColor
            borderTop={true}
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
          />

          {/* Centered two-column content: cat | info+accounts */}
          <Box flexDirection="row" paddingY={1} alignItems="stretch">
            {blockPad > 0 && <Box width={blockPad} />}

            {/* Left: mascot (vertically centered) */}
            <Box width={leftCol} flexDirection="column" justifyContent="center" alignItems="center">
              <Mascot art={mascot} color={accent} />
            </Box>

            {/* Vertical divider */}
            <Box
              borderStyle="single"
              borderColor={accent}
              borderDimColor
              borderTop={false}
              borderBottom={false}
              borderLeft={false}
              borderRight={true}
            />

            {/* Right: info + accounts */}
            <Box width={rightCol} flexDirection="column" justifyContent="center" paddingX={1} gap={1}>
              {/* Info section (left-padded to center) */}
              <Box flexDirection="column" paddingLeft={infoLeftPad}>
                <Text bold color={text}>{welcomeMessage}</Text>
                <Box flexDirection="column" marginTop={1}>
                  <Box flexDirection="row">
                    <Box width={LABEL_WIDTH}><Text color={text} dimColor>Model</Text></Box>
                    <Text color={text}>{truncatedModelLine}</Text>
                  </Box>
                  <Box flexDirection="row">
                    <Box width={LABEL_WIDTH}><Text color={text} dimColor>Workspace</Text></Box>
                    <Text color={text}>{truncatedCwd}</Text>
                  </Box>
                  {agentName && (
                    <Box flexDirection="row">
                      <Box width={LABEL_WIDTH}><Text color={text} dimColor>Agent</Text></Box>
                      <Text color={text}>@{agentName}</Text>
                    </Box>
                  )}
                  <Box flexDirection="row">
                    <Box width={LABEL_WIDTH}><Text color={text} dimColor>Note</Text></Box>
                    <Text color={text} dimColor>% shown is used</Text>
                  </Box>
                </Box>
              </Box>

              {/* Horizontal divider between info and accounts */}
              <Box
                borderStyle="single"
                borderColor={accent}
                borderDimColor
                borderTop={true}
                borderBottom={false}
                borderLeft={false}
                borderRight={false}
              />

              {/* Accounts section */}
              <AccountsPanel availableWidth={rightColContent} accentColor={accent} textColor={text} />
            </Box>
          </Box>
        </Box>
      </OffscreenFreeze>
      {PostBorderNotices}
    </>
  )
}
