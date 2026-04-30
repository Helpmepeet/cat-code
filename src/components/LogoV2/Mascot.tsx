import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { AsciiArt } from './mascots.js'

interface MascotProps {
  art: AsciiArt
  color?: string
}

export function Mascot({ art, color: accentColor }: MascotProps) {
  // Strip the common leading whitespace shared by all non-empty lines so the
  // art's visual content left-aligns with its bounding box.
  const nonEmpty = art.lines.filter((l) => l.trim().length > 0)
  const minLeading = nonEmpty.reduce((min, l) => {
    const leading = l.length - l.trimStart().length
    return Math.min(min, leading)
  }, Infinity)
  const trim = isFinite(minLeading) ? minLeading : 0
  const trimmed = art.lines.map((l) => l.slice(trim).trimEnd())

  return (
    <Box flexDirection="column">
      {trimmed.map((line, i) => (
        <Text key={i} color={accentColor ?? 'startupAccent'}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
