# Renderer engine-type adoption fixture

This is a portable fixture for P1-0. It does not choose or recreate a renderer
directory. P1-0 should copy the two `paths` entries from `tsconfig.json` into
the final renderer package's TypeScript config, adjust their relative targets,
and copy `fixture.ts` into that package as its first typecheck fixture.

Both aliases are type-only. Renderer source must use `import type`, as shown in
`fixture.ts`, so no engine runtime enters the renderer bundle.

## Temporary snapshot fallback

Direct source aliases were attempted first, targeting:

- `src/entrypoints/agentSdkTypes.ts` for `SDKMessage`
- `src/app-runtime/sessionEvents.ts` for `AppSessionEvent`

At commit `234da9e`, TypeScript follows those modules into the engine's broad
runtime graph. That graph has engine-only globals and existing unresolved
modules, so it cannot be checked by an isolated renderer config. The fallback
here is therefore a cited, type-only snapshot permitted by P0-3. It is not a
new runtime protocol or a renderer-owned source of truth.

Before P1-0 adopts this fixture, re-sync both snapshots from the canonical
sources above and rerun:

```sh
bunx tsc --project scripts/typecheck/renderer-engine-types/tsconfig.json --noEmit
```
