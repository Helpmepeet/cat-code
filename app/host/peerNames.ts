/**
 * The peer-session name picker (PEER-SESSIONS §2/§2a, `decisions/PEER-SESSIONS.md`).
 *
 * Every desktop session carries a short name so a model can say "ask Bear"
 * instead of quoting a UUID. Electron main is the one process that sees every
 * registry row, so allocation happens HERE, against the names already on rows —
 * not in an engine process, which sees only itself.
 *
 * **This is a deliberate COPY of `src/agent-mode/workerNames.ts` `pickNext`
 * (`:51-79`), flagged against CLAUDE.md §8 rule 10.** The engine module cannot
 * be reused: it keeps its reservations in a process-local `Set` (`:26`) that its
 * picker always consults (`:52`), so it cannot coordinate N processes; and the
 * host plane cannot import it at all — `app/tsconfig.json` deliberately does not
 * resolve `src/*` (its `include` list names only `main`/`preload`/`supervisor`/
 * `host`/`shared`/`renderer`/`scripts`), and CATALOG-OWNERSHIP ratified that
 * Electron main stays engine-free by design. What is copied is a pure picker
 * with no behavior to drift.
 *
 * Differences from the engine picker, both forced by the multi-process setting:
 *  - No module-global reservation set. The RESERVED SET IS AN ARGUMENT: main
 *    passes the names on current registry rows, which is the real uniqueness
 *    scope (PEER-SESSIONS §2: unique across the ≤ `MAX_REGISTRY_SESSIONS` rows,
 *    released when a row is reaped).
 *  - No module-global cursor. The cursor is in and out, so this module holds no
 *    state and a test can drive it deterministically.
 */

/**
 * The name pool (PEER-SESSIONS R11 / §2a — gems and minerals, extended with
 * metals, alchemy and mining vocabulary). §2a drafted 306 words and said "the
 * build prunes"; 46 were pruned here, leaving 260, and the cuts are itemized in
 * the build report. It MUST stay at or above `MAX_REGISTRY_SESSIONS` (256) —
 * with a smaller pool a suffixed `Bear-2` becomes the ordinary case, which
 * defeats the point of a name.
 *
 * Two pruning rules beyond §2's "short, pronounceable, visually distinct":
 *  - Disjoint from the engine's three SUBAGENT pools, or "send to Turing"
 *    becomes ambiguous the moment both happen to be live.
 *  - Disjoint from vocabulary THIS PRODUCT shows the operator. `Sol` and `Luna`
 *    were cut because the sidebar subtitle that R4 fills with the session name
 *    is the slot that previously read `GPT-5.6 Sol` / `GPT-5.6 Luna`
 *    (`src/services/api/codex-fetch-adapter.ts:594,596`); `Amber` because it is
 *    an accent-theme name the operator picks in Settings
 *    (`app/renderer/src/accentTheme.ts:41`); `Bedrock` because the product names
 *    Amazon Bedrock as a provider.
 *
 * `peerNames.test.ts` asserts the floor, the engine disjointness (read out of
 * the engine file at test time, so a later addition THERE fails HERE), the
 * absence of the model-label words, and that no two entries collide
 * case-insensitively.
 */
export const PEER_NAME_POOL: readonly string[] = [
  // Gems (60)
  'Agate', 'Beryl', 'Citrine', 'Coral', 'Diamond', 'Emerald',
  'Garnet', 'Jade', 'Jasper', 'Jet', 'Lapis', 'Onyx', 'Opal', 'Pearl',
  'Peridot', 'Ruby', 'Sapphire', 'Spinel', 'Topaz', 'Zircon', 'Iolite',
  'Kyanite', 'Larimar', 'Morganite', 'Nephrite', 'Sphene', 'Sugilite',
  'Unakite', 'Charoite', 'Fluorite', 'Selenite', 'Celestite', 'Ammolite',
  'Painite', 'Bixbite', 'Hessonite', 'Prehnite', 'Apatite', 'Azurite',
  'Variscite', 'Malachite', 'Goshenite', 'Heliodor', 'Danburite',
  'Hiddenite', 'Cavansite', 'Benitoite', 'Tsavorite', 'Sardonyx',
  'Scapolite', 'Almandine', 'Uvarovite', 'Sunstone', 'Moonstone',
  'Turquoise', 'Amethyst', 'Carnelian', 'Tanzanite', 'Obsidian',
  'Bloodstone',
  // Minerals and rocks (53)
  'Quartz', 'Feldspar', 'Mica', 'Gypsum', 'Calcite', 'Halite', 'Galena',
  'Pyrite', 'Hematite', 'Bauxite', 'Cinnabar', 'Corundum', 'Dolomite',
  'Barite', 'Talc', 'Olivine', 'Biotite', 'Zeolite', 'Stibnite', 'Cuprite',
  'Rutile', 'Ilmenite', 'Willemite', 'Aragonite', 'Siderite', 'Kaolin',
  'Basalt', 'Marble', 'Slate', 'Flint', 'Chert', 'Pumice', 'Tuff', 'Gneiss',
  'Schist', 'Gabbro', 'Diorite', 'Rhyolite', 'Andesite', 'Dacite', 'Scoria',
  'Breccia', 'Porphyry', 'Syenite', 'Lignite', 'Graphite', 'Ochre', 'Sienna',
  'Loess', 'Alabaster', 'Wulfenite', 'Scheelite', 'Cassiterite',
  // Metals and elements (53)
  'Gold', 'Silver', 'Copper', 'Iron', 'Tin', 'Zinc', 'Nickel', 'Cobalt',
  'Platinum', 'Iridium', 'Osmium', 'Rhodium', 'Titanium', 'Tungsten',
  'Chromium', 'Vanadium', 'Bismuth', 'Antimony', 'Mercury', 'Cadmium',
  'Tantalum', 'Niobium', 'Silicon', 'Sulfur', 'Carbon', 'Boron', 'Lithium',
  'Sodium', 'Cesium', 'Radium', 'Uranium', 'Thorium', 'Yttrium', 'Scandium',
  'Erbium', 'Hafnium', 'Magnesium', 'Strontium', 'Rubidium', 'Potassium',
  'Argon', 'Neon', 'Krypton', 'Xenon', 'Radon', 'Helium', 'Bronze', 'Brass',
  'Steel', 'Pewter', 'Electrum', 'Sterling', 'Invar',
  // Alchemy (40)
  'Aether', 'Azoth', 'Elixir', 'Tincture', 'Crucible', 'Alembic', 'Retort',
  'Athanor', 'Cucurbit', 'Pelican', 'Mortar', 'Pestle', 'Calx', 'Regulus',
  'Vitriol', 'Nitre', 'Alum', 'Natron', 'Verdigris', 'Litharge', 'Minium',
  'Realgar', 'Orpiment', 'Philtre', 'Nigredo', 'Albedo', 'Rubedo',
  'Ouroboros', 'Hermes', 'Paracelsus', 'Flamel', 'Zosimos', 'Geber', 'Rebis',
  'Homunculus', 'Basilisk', 'Salamander', 'Undine', 'Sylph', 'Gnome',
  // Mining (54)
  'Shaft', 'Adit', 'Drift', 'Stope', 'Lode', 'Vein', 'Seam', 'Reef',
  'Placer', 'Ore', 'Tailings', 'Gangue', 'Headframe', 'Winze', 'Crosscut',
  'Gallery', 'Tunnel', 'Quarry', 'Sluice', 'Rocker', 'Cradle', 'Riffle',
  'Nugget', 'Assay', 'Smelter', 'Furnace', 'Anvil', 'Ingot', 'Bloom', 'Slag',
  'Flux', 'Kiln', 'Bellows', 'Mattock', 'Auger', 'Lantern', 'Canary',
  'Hoist', 'Windlass', 'Kibble', 'Stull', 'Pillar', 'Muck', 'Spoil',
  'Grubstake', 'Prospect', 'Motherlode', 'Bonanza', 'Gulch',
  'Paydirt', 'Kobold', 'Collier', 'Hewer', 'Banksman',
]

/**
 * The comparison key for "is this name taken": trimmed and lowercased, the
 * `recipientNameKey` rule (`src/utils/recipientIdentity.ts:21`) re-implemented
 * host-side for the same reason the registry re-implements the config-home
 * rules — the host plane imports nothing from `src/**`.
 */
export function peerNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** A random starting offset, so the first session of a run is not always the
 * first pool entry. The engine seeds its per-pool cursor the same way
 * (`workerNames.ts:42`). */
export function randomPeerNameCursor(pool: readonly string[] = PEER_NAME_POOL): number {
  return Math.floor(Math.random() * pool.length)
}

/**
 * Pick the next free name, and the cursor to pass next time.
 *
 * Walks the pool once from `cursor`, skipping every reserved name
 * (case-insensitively). On a full pool it falls back to suffixing the entry AT
 * the cursor — `<Base>-2`, `-3`, … until free — which is exactly what the engine
 * picker does: its second loop can only ever run its first iteration before
 * returning (`workerNames.ts:63-76`), so the loop there is written out but is
 * straight-line in effect. Written straight-line here.
 *
 * Throws on an empty pool, the one input that has no answer (the engine throws
 * too, `workerNames.ts:78`). `PEER_NAME_POOL` is never empty; only a caller
 * passing its own pool can reach it.
 */
export function pickPeerName(
  reservedNames: Iterable<string>,
  cursor: number,
  pool: readonly string[] = PEER_NAME_POOL,
): { name: string; nextCursor: number } {
  if (pool.length === 0) throw new Error('peer name pool must not be empty')
  const reserved = new Set<string>()
  for (const name of reservedNames) reserved.add(peerNameKey(name))

  const start = normalizeCursor(cursor, pool.length)
  for (let offset = 0; offset < pool.length; offset += 1) {
    const index = (start + offset) % pool.length
    const candidate = pool[index]!
    if (!reserved.has(peerNameKey(candidate))) {
      return { name: candidate, nextCursor: (index + 1) % pool.length }
    }
  }

  const base = pool[start]!
  let suffix = 2
  let candidate = `${base}-${suffix}`
  while (reserved.has(peerNameKey(candidate))) {
    suffix += 1
    candidate = `${base}-${suffix}`
  }
  return { name: candidate, nextCursor: (start + 1) % pool.length }
}

/** A caller's cursor is state it kept across calls; tolerate anything. */
function normalizeCursor(cursor: number, length: number): number {
  if (!Number.isFinite(cursor)) return 0
  const index = Math.trunc(cursor) % length
  return index < 0 ? index + length : index
}
