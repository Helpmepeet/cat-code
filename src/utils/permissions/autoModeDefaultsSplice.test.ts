/**
 * The regression these guard is silent and severe: the vendored template wraps
 * its defaults INSIDE the <user_*_to_replace> tags, so a plain replace deletes
 * every shipped rule the moment a user configures one of their own. Nothing
 * fails, nothing logs; the classifier just stops enforcing secrets, sudo, and
 * git push.
 *
 * The splice is exercised against the REAL vendored upstream template rather
 * than a fixture, because a fixture cannot show that the shipped rules survived.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  AUTO_MODE_DEFAULTS_SENTINEL,
  assembleUpstreamSystemPrompt,
  autoModeSectionDropsDefaults,
  spliceAutoModeDefaults,
  spliceAutoModeDefaultsList,
  transformUpstreamRuntimePrompt,
} from './autoModeDefaultsSplice.js'

const UPSTREAM_DIR = join(
  import.meta.dir,
  'yolo-classifier-prompts',
  'upstream',
)
const BASE = readFileSync(join(UPSTREAM_DIR, 'system_prompt.txt'), 'utf-8')
const PERMISSIONS = readFileSync(join(UPSTREAM_DIR, 'permissions.txt'), 'utf-8')

/**
 * One phrase from each section's rule BODY. Rule *names* are unusable as probes
 * because upstream rules cross-reference each other by name, so a name survives
 * its own section being replaced. Each of these occurs exactly once in the
 * vendored inventory and never in module 1.
 */
const SHIPPED = {
  hard: 'arming an automated pathway',
  soft: 'rewriting remote history',
  allow: 'engaging with security as subject matter',
  environment: 'Primary use of Claude Code',
}

describe('spliceAutoModeDefaults', () => {
  test('returns the defaults untouched when the user configured nothing', () => {
    expect(spliceAutoModeDefaults(undefined, '- shipped rule')).toBe(
      '- shipped rule',
    )
    expect(spliceAutoModeDefaults([], '- shipped rule')).toBe('- shipped rule')
  })

  test('keeps the defaults when the user asks for them back', () => {
    const out = spliceAutoModeDefaults(
      [AUTO_MODE_DEFAULTS_SENTINEL, 'my own rule'],
      '- shipped rule',
    )
    expect(out).toBe('- shipped rule\n- my own rule')
  })

  test('drops the defaults when the sentinel is absent', () => {
    // Upstream's documented behaviour, and precisely the hazard the startup
    // warning exists to surface.
    expect(spliceAutoModeDefaults(['my own rule'], '- shipped rule')).toBe(
      '- my own rule',
    )
  })

  test('places the defaults where the sentinel sits', () => {
    expect(
      spliceAutoModeDefaults(['first', AUTO_MODE_DEFAULTS_SENTINEL], '- ship'),
    ).toBe('- first\n- ship')
  })

  test('expands only the first sentinel', () => {
    expect(
      spliceAutoModeDefaults(
        [AUTO_MODE_DEFAULTS_SENTINEL, 'mine', AUTO_MODE_DEFAULTS_SENTINEL],
        '- ship',
      ),
    ).toBe('- ship\n- mine')
  })
})

describe('spliceAutoModeDefaultsList', () => {
  // `claude auto-mode config` reports the operator's effective posture. If it
  // resolved differently from the prompt, it would misreport their own safety
  // settings back to them.
  test('agrees with the text splice on every case that matters', () => {
    const defaults = ['ship one', 'ship two']
    expect(spliceAutoModeDefaultsList(undefined, defaults)).toEqual(defaults)
    expect(spliceAutoModeDefaultsList([], defaults)).toEqual(defaults)
    expect(spliceAutoModeDefaultsList(['mine'], defaults)).toEqual(['mine'])
    expect(
      spliceAutoModeDefaultsList([AUTO_MODE_DEFAULTS_SENTINEL, 'mine'], defaults),
    ).toEqual(['ship one', 'ship two', 'mine'])
    expect(
      spliceAutoModeDefaultsList(['mine', AUTO_MODE_DEFAULTS_SENTINEL], defaults),
    ).toEqual(['mine', 'ship one', 'ship two'])
    expect(
      spliceAutoModeDefaultsList(
        [AUTO_MODE_DEFAULTS_SENTINEL, 'mine', AUTO_MODE_DEFAULTS_SENTINEL],
        defaults,
      ),
    ).toEqual(['ship one', 'ship two', 'mine'])
  })

  test('returns a copy, so a caller cannot mutate the shipped defaults', () => {
    const defaults = ['ship']
    const out = spliceAutoModeDefaultsList(undefined, defaults)
    out.push('injected')
    expect(defaults).toEqual(['ship'])
  })
})

describe('autoModeSectionDropsDefaults', () => {
  test('flags a configured section that omits the sentinel', () => {
    expect(autoModeSectionDropsDefaults(['mine'])).toBe(true)
  })

  test('stays quiet for an unconfigured section or one that keeps defaults', () => {
    expect(autoModeSectionDropsDefaults(undefined)).toBe(false)
    expect(autoModeSectionDropsDefaults([])).toBe(false)
    expect(autoModeSectionDropsDefaults([AUTO_MODE_DEFAULTS_SENTINEL])).toBe(
      false,
    )
  })
})

describe('assembleUpstreamSystemPrompt', () => {
  test('inlines the rule inventory and empties the unshipped slot', () => {
    const out = assembleUpstreamSystemPrompt(BASE, PERMISSIONS, undefined)
    expect(out).toContain('<cc_automode_permissions>')
    expect(out).not.toContain('<permissions_template>')
    expect(out).not.toContain('<cross_session_messages_rule>')
    // A wrapper around ordinary prose, not a slot: it must survive.
    expect(out).toContain('<cc_automode_session_rules>')
  })

  test('carries every shipped rule when the user configured nothing', () => {
    const out = assembleUpstreamSystemPrompt(BASE, PERMISSIONS, undefined)
    for (const rule of Object.values(SHIPPED)) expect(out).toContain(rule)
  })

  test('keeps the shipped rules in every section the user extends', () => {
    const out = assembleUpstreamSystemPrompt(BASE, PERMISSIONS, {
      allow: [AUTO_MODE_DEFAULTS_SENTINEL, 'my allow rule'],
      soft_deny: [AUTO_MODE_DEFAULTS_SENTINEL, 'my soft rule'],
      hard_deny: [AUTO_MODE_DEFAULTS_SENTINEL, 'my hard rule'],
      environment: [AUTO_MODE_DEFAULTS_SENTINEL, 'my environment fact'],
    })
    for (const rule of Object.values(SHIPPED)) expect(out).toContain(rule)
    for (const mine of [
      'my allow rule',
      'my soft rule',
      'my hard rule',
      'my environment fact',
    ]) {
      expect(out).toContain(`- ${mine}`)
    }
  })

  test('a soft_deny config without the sentinel drops the shipped deny rules', () => {
    // The B1 failure, pinned so it can never become the accidental default:
    // configuring one section must not disturb the others.
    const out = assembleUpstreamSystemPrompt(BASE, PERMISSIONS, {
      soft_deny: ['my only rule'],
    })
    expect(out).toContain('- my only rule')
    expect(out).not.toContain(SHIPPED.soft)
    expect(out).toContain(SHIPPED.hard)
    expect(out).toContain(SHIPPED.allow)
  })

  test('leaves no substitution tag unresolved', () => {
    const out = assembleUpstreamSystemPrompt(BASE, PERMISSIONS, {
      soft_deny: [AUTO_MODE_DEFAULTS_SENTINEL, 'mine'],
    })
    expect(out).not.toMatch(/<user_[a-z_]+_to_replace>/)
  })

  test('transforms the immutable upstream XML contract for the forced tool', () => {
    const runtime = transformUpstreamRuntimePrompt(BASE, PERMISSIONS)
    const out = assembleUpstreamSystemPrompt(BASE, PERMISSIONS, undefined)

    expect(runtime.basePrompt).toContain('`classify_result` tool')
    expect(runtime.basePrompt).not.toContain('<block>')
    expect(runtime.permissionsTemplate).not.toContain('<settings_deny_rules>')
    expect(out.match(/<settings_deny_rules>/g) ?? []).toHaveLength(0)
    expect(out.match(/<\/settings_deny_rules>/g) ?? []).toHaveLength(0)
    expect(
      createHash('sha256')
        .update(out)
        .digest('hex'),
    ).toBe('7a0f0472b3ced381e7b6683f00b14663c5a609ebaffd0aac9586373aabb97503')
  })
})
