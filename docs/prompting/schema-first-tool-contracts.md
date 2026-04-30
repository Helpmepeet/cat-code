# Phase 0: Schema-First Tool Contracts — Implementation Plan

**Status:** Ready for implementation
**Scope:** Two provider-aware adaptations in the tool serialization layer. No tool implementation changes.

---

## Audit Results

Before finalizing the plan, every dimension called out in the deep-research report's "Structured outputs and JSON schema limits" section and the "Strict schema tool calling" comparison row was audited against the actual codebase. The findings below explain which gaps are real, which are already handled, and which don't apply.

### Dimensions checked

| # | Dimension (from research report) | Requirement for OpenAI strict mode | What our schemas emit | Does the adapter compensate? | Verdict |
|---|---|---|---|---|---|
| 1 | **`$schema` meta-field** | Not expected in function `parameters` | Present on every Zod-generated schema (`zodToJsonSchema()` → `toJSONSchema()` emits it) | No — `translateTools()` passes `input_schema` through as `parameters` unchanged | **Gap.** Wastes tokens; could confuse schema processing. See Change 1. |
| 2 | **Dash-prefixed property names** | Strict mode requires valid identifiers; non-strict is advisory but model may struggle with `-A`, `-B`, etc. | GrepTool defines `-A`, `-B`, `-C`, `-n`, `-i` in its Zod schema. **No other tool has dash-prefixed property names** (verified via `rg "'-[a-zA-Z]'" src/tools/` filtered to schema definitions). | No — passed through unchanged | **Gap.** Model behavioral issue (may fail to use these correctly). See Change 2. |
| 3 | **`additionalProperties: false`** | Required on all objects in strict mode | Already present on all schemas. Zod v4's `toJSONSchema()` emits `additionalProperties: false` for **both** `z.object()` and `z.strictObject()`. Verified empirically. | N/A | **No gap.** |
| 4 | **All properties in `required` + optionality via null union** | Required in strict mode: every property must be in `required`, optional expressed as `type: ["string", "null"]` | Zod produces standard JSON Schema: optional fields omitted from `required`, no null union. | **Irrelevant.** `translateTools()` sets `strict: null`, explicitly disabling strict mode. The API treats the schema as advisory, not enforced. | **No gap.** `strict: null` makes this a non-issue. If strict mode is ever enabled, this becomes a real problem requiring a schema rewrite pass. |
| 5 | **Auto-strict normalization** | Research report warns: "Responses requests may normalize your schema into strict mode when `strict` is omitted" | N/A | **Handled.** `translateTools()` sets `strict: null` (explicit opt-out), not omitted. Auto-normalization only applies when the field is absent entirely. | **No gap.** |
| 6 | **Nesting depth limit** | Max 10 levels of nesting | All tool schemas are flat or 2-3 levels deep (root → array → item object → optional nested object). The deepest is ~4 levels. Verified by examining AgentTool, TodoWriteTool, and all tools with nested `z.object`/`z.array`. | N/A | **No gap.** |
| 7 | **Total properties limit** | Max 5000 object properties total | The most complex tool schema (GrepTool) has 14 properties. AgentTool has ~8. No tool approaches even 50. | N/A | **No gap.** |
| 8 | **Enum limits** | Limits on enum count and string length | All enums in tool schemas have 2-5 values (e.g., `['content', 'files_with_matches', 'count']`). | N/A | **No gap.** |
| 9 | **`anyOf` / union types** | Supported by OpenAI Structured Outputs | `anyOf` appears in nullable field encoding (Zod `z.nullable()` → `anyOf: [{type: "string"}, {type: "null"}]`). Also in `z.union()` but that's only used in agent definition schemas (YAML frontmatter parsing), not in tool API schemas. | N/A | **No gap.** |
| 10 | **MCP tool schemas with `$schema`** | Same as #1 | MCP tools use `inputJSONSchema` (raw JSON Schema from external servers), bypassing `zodToJsonSchema()`. They could contain `$schema`. | No — `toolToAPISchema()` passes `inputJSONSchema` through to `input_schema` unchanged. | **Potential gap, but out of scope.** MCP schemas are third-party; we can't control their content. The `$schema` strip for Zod schemas (Change 1) doesn't help here. If this becomes a real problem, add a strip in `toolToAPISchema()` for the `inputJSONSchema` path. Not addressing in this phase. |
| 11 | **`strict: true` from Anthropic path leaking to OpenAI** | Would trigger strict validation on malformed schemas | `modelSupportsStructuredOutputs()` returns `false` for `provider === 'openai'` (gated at `betas.ts:146`), so `base.strict` is never set for OpenAI models. Even if it were, `translateTools()` overrides to `strict: null`. Double defense. | Yes — two independent guards | **No gap.** |

### Conclusion

**The original two problems are the only real gaps.** Everything else is either already handled by `translateTools()` setting `strict: null`, already correct in the Zod v4 output, or well within OpenAI's limits. The optionality encoding difference (#4) would become a real problem if strict mode were ever enabled on the OpenAI path, but that's a future concern gated behind `strict: null`.

---

## Problem Statement

Two issues affect tool calling quality on the OpenAI/Codex path:

1. **`$schema` field in tool JSON schemas.** `zodToJsonSchema()` (via Zod v4's `toJSONSchema()`) emits `"$schema": "https://json-schema.org/draft/2020-12/schema"` at the top of every tool's `input_schema`. Since `translateTools()` sets `strict: null`, the Codex backend won't reject it as a 400 — but it wastes tokens in every request's tool definitions and is not meaningful to the model. It should be stripped.

2. **Dash-prefixed property names in GrepTool.** GrepTool's Zod schema defines properties `-A`, `-B`, `-C`, `-n`, and `-i`. With `strict: null`, the API won't reject these. The failure mode is **behavioral**: GPT models may struggle to correctly generate JSON with dash-prefixed keys (they look like CLI flags, not JSON property names), leading to omitted fields or validation errors at `safeParse` time. On the OpenAI path, these must be renamed to valid identifiers in the schema, and the reverse mapping must be applied to model input before Zod validation.

Neither gap produces a hard 400 error today. Both are quality/reliability issues that degrade the OpenAI path's tool-calling accuracy.

---

## Rename Table

| Original (Zod / Claude path) | Renamed (OpenAI path) | Rationale |
|---|---|---|
| `-A` | `lines_after` | Descriptive; no collision |
| `-B` | `lines_before` | Descriptive; no collision |
| `-C` | `context_lines` | `context` already exists in the schema |
| `-n` | `show_line_numbers` | Descriptive; no collision |
| `-i` | `case_insensitive` | Descriptive; no collision |

---

## Change 1: Strip `$schema` unconditionally

### Location

**File:** `src/utils/zodToJsonSchema.ts`
**Function:** `zodToJsonSchema()`

### Current behavior

```ts
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  const result = toJSONSchema(schema) as JsonSchema7Type
  cache.set(schema, result)
  return result
}
```

The returned object always contains `"$schema"`. This field is harmless on the Anthropic path (Claude ignores it; the Anthropic SDK has zero references to `$schema`), but it is unnecessary overhead on all paths.

### Design decision

**Strip `$schema` unconditionally inside `zodToJsonSchema()`, not conditionally per provider.** Rationale:

- Claude does not use `$schema` — it is JSON Schema metadata, not a behavioral field.
- The Anthropic SDK does not reference or require it.
- Stripping unconditionally means the cached result is provider-neutral, avoiding the need for per-provider cache keys.
- Slightly smaller serialized tool arrays on all paths (fewer bytes → marginally better cache hit rate on the Anthropic prefix cache).

### Exact change

In `zodToJsonSchema()`, after `toJSONSchema()` returns, delete the `$schema` key before caching:

```ts
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  const result = toJSONSchema(schema) as JsonSchema7Type
  delete result['$schema']
  cache.set(schema, result)
  return result
}
```

**One line added.** No other changes needed.

### Why not strip in `toolToAPISchema()` or `translateTools()`?

- `toolToAPISchema()` caches the base schema object per session. Stripping there would require either mutating the cached object (unsafe) or cloning before caching (wasteful per-call). Stripping at the source is cleaner.
- `translateTools()` could strip it, but that leaves the field present in the Anthropic path's serialized tool array for no benefit, and adds a second location to maintain.
- Note: this does NOT cover MCP tools that use `inputJSONSchema` (they bypass `zodToJsonSchema()`). If MCP schemas with `$schema` become a problem, add a strip in `toolToAPISchema()` on the `inputJSONSchema` branch. Not in scope for this change.

---

## Change 2: Rename dash-prefixed GrepTool properties on the OpenAI path

This change has three parts: (a) the mapping data structure, (b) schema adaptation at serialization time, and (c) reverse mapping at input time.

### Part 2a: The mapping constant

**File:** `src/utils/openaiSchemaCompat.ts` **(new file)**

Define the rename mapping here, not in GrepTool.ts. Reason: `src/utils/api.ts` imports this for both schema adaptation and input normalization. Having `api.ts` import from `tools/GrepTool/` would invert the dependency direction (utils should not import from tools).

```ts
/**
 * Maps dash-prefixed property names to valid identifiers for providers
 * that require identifier-safe property names (e.g., OpenAI).
 *
 * Today only GrepTool has dash-prefixed properties (-A, -B, -C, -n, -i).
 * Used by toolToAPISchema (outbound schema adaptation) and
 * normalizeToolInput (inbound input reverse-mapping).
 */
export const OPENAI_PROPERTY_RENAMES: Record<string, string> = {
  '-A': 'lines_after',
  '-B': 'lines_before',
  '-C': 'context_lines',
  '-n': 'show_line_numbers',
  '-i': 'case_insensitive',
}

/** Inverse of OPENAI_PROPERTY_RENAMES: renamed → original. */
export const OPENAI_PROPERTY_RENAMES_INVERSE: Record<string, string> =
  Object.fromEntries(
    Object.entries(OPENAI_PROPERTY_RENAMES).map(([k, v]) => [v, k]),
  )
```

### Part 2b: Schema adaptation in `toolToAPISchema()`

**File:** `src/utils/api.ts`
**Function:** `toolToAPISchema()`

#### Where in the function

After `input_schema` is computed (line ~161) and after the swarm field filter (line ~167), but before the schema is stored in the cache (line ~169). The provider check must gate this so it only runs on the OpenAI path.

#### Guard condition

```ts
getAPIProvider() === 'openai'
```

(`getAPIProvider` is already imported at line 49.)

#### What the adaptation does

When the provider is `'openai'` and the tool's `input_schema.properties` contains any key from `OPENAI_PROPERTY_RENAMES`:

1. Clone `properties` (shallow copy of the properties object).
2. For each entry in `OPENAI_PROPERTY_RENAMES` where the key exists in `properties`: copy the value under the new key, delete the old key.
3. If the schema has a `required` array, apply the same renames to it.
4. Replace `input_schema` with the modified clone.

#### Pseudocode

```ts
if (getAPIProvider() === 'openai') {
  const props = input_schema.properties
  if (props && typeof props === 'object') {
    const renames = OPENAI_PROPERTY_RENAMES
    const hasRenames = Object.keys(renames).some(k => k in (props as Record<string, unknown>))
    if (hasRenames) {
      const newProps = { ...(props as Record<string, unknown>) }
      for (const [oldKey, newKey] of Object.entries(renames)) {
        if (oldKey in newProps) {
          newProps[newKey] = newProps[oldKey]
          delete newProps[oldKey]
        }
      }
      // Also rename in the required array if present
      let newRequired = input_schema.required as string[] | undefined
      if (Array.isArray(newRequired)) {
        newRequired = newRequired.map(r => renames[r] ?? r)
      }
      input_schema = {
        ...input_schema,
        properties: newProps,
        ...(newRequired && { required: newRequired }),
      }
    }
  }
}
```

#### Why not put this in `translateTools()`?

`translateTools()` in `codex-fetch-adapter.ts` operates on the already-serialized Anthropic `input_schema` object. It could work there, but:

- `toolToAPISchema()` is the documented single choke point all tool schemas pass through — it's the right place for provider-aware schema adaptation.
- The schema cache in `toolToAPISchema()` is keyed by tool name (or name + schema for StructuredOutput). Since the provider is session-stable, the cached schema is already implicitly provider-specific for the session. No cache key change needed.
- Keeping provider adaptation in one place (the serialization layer) rather than splitting between serialization and the fetch adapter is easier to reason about.

#### Scope: applies to ALL tools, not just GrepTool

The rename check uses `Object.keys(renames).some(k => k in props)` which is a no-op for tools that don't have dash-prefixed properties. This means the code is generic — if another tool later adds dash-prefixed properties, they just need an entry in the rename map. But today, only GrepTool is affected (verified by audit).

### Part 2c: Reverse mapping at input time

**File:** `src/utils/api.ts`
**Function:** `normalizeToolInput()`

#### Call flow context

1. Model produces input JSON → parsed in `messages.ts:~2680`
2. `normalizeToolInput()` is called in `messages.ts:~2707` (tool-specific corrections)
3. The corrected input is stored in the message
4. Later, `toolExecution.ts:615` calls `tool.inputSchema.safeParse(input)`
5. If valid, `call()` receives the parsed input

**The reverse mapping must happen in step 2** — inside `normalizeToolInput()` — so that by the time step 4 runs, the input has the original dash-prefixed keys that match the Zod schema.

#### Guard condition

```ts
getAPIProvider() === 'openai'
```

#### Exact change

Add a block at the **top** of `normalizeToolInput()`, before the `switch` statement:

```ts
export function normalizeToolInput<T extends Tool>(
  tool: T,
  input: z.infer<T['inputSchema']>,
  agentId?: AgentId,
): z.infer<T['inputSchema']> {
  // Reverse-map OpenAI-renamed properties back to original dash-prefixed names.
  // On the OpenAI path, toolToAPISchema() renames dash-prefixed properties
  // (e.g., -A → lines_after) to satisfy identifier requirements. The model
  // responds with the renamed keys, so we must map them back before Zod parse.
  if (getAPIProvider() === 'openai' && typeof input === 'object' && input !== null) {
    const inverse = OPENAI_PROPERTY_RENAMES_INVERSE
    const inputObj = input as Record<string, unknown>
    let changed = false
    for (const [renamed, original] of Object.entries(inverse)) {
      if (renamed in inputObj && !(original in inputObj)) {
        inputObj[original] = inputObj[renamed]
        delete inputObj[renamed]
        changed = true
      }
    }
    if (changed) {
      input = inputObj as z.infer<T['inputSchema']>
    }
  }

  switch (tool.name) {
    // ... existing cases unchanged
  }
}
```

#### Why the `!(original in inputObj)` guard?

Safety: if a model somehow sends both `lines_after` and `-A`, prefer the original `-A` and don't overwrite it. This shouldn't happen in practice, but the guard prevents data loss.

#### Why mutate `inputObj` in-place?

`normalizeToolInput()` already mutates and returns new objects in its switch cases (e.g., the BashTool case returns a new object). The pattern is consistent. The mutation happens on the parsed JSON object from the model response, not on a shared/cached reference, so it's safe.

---

## What NOT to touch

| Item | Why it must remain unchanged |
|---|---|
| **GrepTool's Zod schema** (`src/tools/GrepTool/GrepTool.ts`, `inputSchema`) | The Zod schema defines the source-of-truth property names. The `call()` method destructures `-A`, `-B`, `-C`, `-n`, `-i` by name. Changing the schema would require changing every tool implementation that references these names. |
| **GrepTool's `call()` method** | Destructures the original dash-prefixed names. The reverse mapping in `normalizeToolInput()` ensures these names are present by the time `call()` runs. |
| **`translateTools()` in `codex-fetch-adapter.ts`** | Already sets `strict: null` explicitly. No schema adaptation needed there — it receives the already-adapted schema from `toolToAPISchema()`. The `strict: null` is load-bearing: it prevents auto-strict normalization and means optionality encoding differences don't matter. |
| **Any other tool's Zod schema or implementation** | Only GrepTool has dash-prefixed properties. No other tool is affected. Verified by auditing all tool schema definitions. |
| **The Claude/Anthropic path's serialized tool schemas** | The `$schema` removal is safe (Claude doesn't use it; Anthropic SDK has zero `$schema` references). The property rename is gated by `getAPIProvider() === 'openai'`, so Claude never sees renamed properties. Cache keys are session-stable, so there's no cross-provider cache collision. |
| **`toolExecution.ts` `safeParse` call** | The reverse mapping happens upstream in `normalizeToolInput()`, so by the time `safeParse` runs, the input has the original property names. No change needed at the validation layer. |
| **Optionality encoding** (not adding null unions / not moving all fields to `required`) | `strict: null` in `translateTools()` means OpenAI treats schemas as advisory. Standard JSON Schema optionality (optional = not in required) works fine in non-strict mode. If strict mode is ever enabled on the OpenAI path, this becomes a real problem requiring a separate schema rewrite pass. |

---

## Verification Steps

### 1. Confirm `$schema` is stripped

```ts
// Unit test:
import { zodToJsonSchema } from './zodToJsonSchema'
import { z } from 'zod/v4'
const schema = z.object({ foo: z.string() })
const result = zodToJsonSchema(schema)
assert(!('$schema' in result))
assert(result.type === 'object')  // other fields preserved
```

### 2. Confirm Claude path is unchanged (minus `$schema`)

Before and after the change, capture the serialized tool array sent to the Anthropic API (temporary log in `toolToAPISchema()` printing `JSON.stringify(schema)` for GrepTool). Diff: the only change should be the absence of the `"$schema"` key. All property names, descriptions, types, and ordering must be identical.

### 3. Confirm OpenAI path schema has renamed properties

In a debug session with an OpenAI model selected, add a temporary log in `toolToAPISchema()` after the rename block. For GrepTool, verify:
- `properties` contains `lines_after`, `lines_before`, `context_lines`, `show_line_numbers`, `case_insensitive`
- `properties` does NOT contain `-A`, `-B`, `-C`, `-n`, `-i`
- `$schema` is not present
- All other properties (`pattern`, `path`, `glob`, `output_mode`, `context`, `type`, `head_limit`, `offset`, `multiline`) are unchanged

### 4. Confirm reverse mapping works end-to-end

On the OpenAI path:
1. Trigger a GrepTool call that uses context flags (e.g., search with `lines_after: 3`)
2. Add a log in `normalizeToolInput` before and after the reverse mapping
3. Verify the input passed to `safeParse` has the original `-A` key (not `lines_after`)
4. Verify the GrepTool `call()` executes successfully and returns results

### 5. Confirm non-GrepTool tools are unaffected

On the OpenAI path, verify that tools without dash-prefixed properties (e.g., BashTool, FileEditTool) pass through `toolToAPISchema()` and `normalizeToolInput()` without any property changes. The rename check short-circuits when no dash-prefixed keys exist in properties.

### 6. Run existing tests

```bash
bun run build && bun test
```

All existing GrepTool tests should pass because:
- Tests run with the default provider (firstParty/Anthropic), not OpenAI
- The `$schema` removal doesn't affect Zod parse behavior
- No tool implementations were changed

---

## Future concerns (not in scope)

1. **OpenAI strict mode adoption.** If `strict: null` is ever changed to `strict: true` in `translateTools()`, the optionality encoding gap (#4 in the audit) becomes a hard 400 failure. Every optional property would need to be moved into `required` with a `type: [..., "null"]` union. This is a significant schema transformation — flag it as a prerequisite before enabling strict mode.

2. **MCP tool `$schema` stripping.** MCP tools bypass `zodToJsonSchema()` and use `inputJSONSchema` directly. If third-party MCP servers include `$schema` in their tool schemas, it reaches the Codex backend. Not a known problem today, but if it becomes one, add a `delete input_schema['$schema']` in `toolToAPISchema()` on the `inputJSONSchema` branch.

---

## Summary of files changed

| File | What changes |
|---|---|
| `src/utils/zodToJsonSchema.ts` | Add `delete result['$schema']` after `toJSONSchema()` call |
| `src/utils/openaiSchemaCompat.ts` | **New file.** Defines `OPENAI_PROPERTY_RENAMES` and `OPENAI_PROPERTY_RENAMES_INVERSE` |
| `src/utils/api.ts` | Import the rename maps from `openaiSchemaCompat.ts`. In `toolToAPISchema()`: add property rename block gated on `getAPIProvider() === 'openai'`. In `normalizeToolInput()`: add reverse-mapping pre-pass gated on `getAPIProvider() === 'openai'`. |
