/**
 * Outbound secret-key guard (SECURITY-MINIMUM §4 — "No token field crosses IPC",
 * review finding F6).
 *
 * The engine (sidecar) is the sole secret owner; known credential-bearing keys
 * are blocked at the serializer boundary to prevent key leak. This is a
 * defense-in-depth serializer-level assertion: before ANY frame leaves the
 * sidecar, we walk it and reject one that carries a known-secret key. It is
 * distinct from the JSON-safe check (which only proves losslessness) — a
 * `{accessToken:"..."}` object is structurally valid JSON, so `checkJsonSafe`
 * passes it; this guard is what stops it.
 *
 * Applied to every outbound frame the sidecar sends EXCEPT `error` (see
 * `sidecarServer.ts` `send`): a blocked frame is reported as an error frame, so
 * scanning those too would let the guard's own report re-enter the guard. The
 * exemption holds only while error frames stay sidecar-authored and carry no
 * session payload — an error frame that ever echoes engine data would need the
 * scan back. Everything else is covered, `ready` included, because the
 * handshake payload embeds session state that is a plausible accidental leak
 * site.
 */

/**
 * Known-secret key names, NORMALIZED (lowercased, separators removed) so
 * `accessToken`, `access_token`, and `access-token` all match the one entry.
 * Add the canonical camelCase spelling here; `normalizeKey` folds the variants.
 */
const SECRET_KEYS = new Set(
  [
    'accessToken',
    'refreshToken',
    'apiKey',
    'apiKeys',
    'vaultFilePath',
    'idToken',
    'clientSecret',
    'privateKey',
    'password',
    'authorization',
  ].map(normalizeKey),
)

/**
 * Depth guard. Real SDK payloads do not nest anywhere near this deep, so a value
 * that exceeds it is anomalous. Unlike the previous cap this FAILS CLOSED (F6):
 * a payload too deep to fully scan is rejected, never waved through — a secret
 * could otherwise be hidden below the limit.
 */
const MAX_DEPTH = 256

export type SecretScanResult = { ok: true } | { ok: false; path: string; key: string }

/** Fold a key to its normalized form: lowercase, no `_`/`-`/space separators. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '')
}

/** Walk `value` and fail on the first known-secret key found. */
export function scanForSecrets(value: unknown): SecretScanResult {
  return walk(value, '$', 0, new Set())
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
): SecretScanResult {
  if (value === null || typeof value !== 'object') {
    return { ok: true }
  }
  // Fail closed: a value nested past MAX_DEPTH cannot be fully scanned, so it is
  // rejected rather than trusted (a secret could hide below the cutoff).
  if (depth > MAX_DEPTH) {
    return { ok: false, path, key: `<exceeds max depth ${MAX_DEPTH}>` }
  }
  const obj = value as object
  if (seen.has(obj)) return { ok: true }
  seen.add(obj)

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = walk((obj as unknown[])[i], `${path}[${i}]`, depth + 1, seen)
      if (!r.ok) return r
    }
    seen.delete(obj)
    return { ok: true }
  }

  for (const key of Object.keys(obj)) {
    if (SECRET_KEYS.has(normalizeKey(key))) {
      return { ok: false, path: `${path}.${key}`, key }
    }
    const r = walk((obj as Record<string, unknown>)[key], `${path}.${key}`, depth + 1, seen)
    if (!r.ok) return r
  }
  seen.delete(obj)
  return { ok: true }
}
