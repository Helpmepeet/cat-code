#!/usr/bin/env bun
/**
 * P4-27 (B5): recompute PARITY-LEDGER.md Part D from the Part A/B DETAIL rows,
 * instead of hand-counting. Part D had drifted out of sync with three
 * different "built" totals coexisting (detail 595 / rollup 370 / Totals 312).
 *
 * Parses every "### NN. Surface" (Part A) and "### FLOW-N. Name" (Part B)
 * section, scans its element table for the Disposition cell (the cell whose
 * trimmed text starts with one of the 6 marker glyphs — robust to the
 * differing column layout between surface tables (5 cols) and flow tables
 * (6 cols)), and tallies dispositions per section + totals.
 *
 * Usage: bun run scripts/parity-ledger-count.ts [path-to-ledger]
 */

const path = process.argv[2] ?? "docs/migration/PARITY-LEDGER.md";
const text = await Bun.file(path).text();
const lines = text.split("\n");

const MARKERS = ["✅", "🔁", "➕", "⬜", "✂️", "❓"] as const;
type Marker = (typeof MARKERS)[number];

type Section = {
  kind: "surface" | "flow";
  id: string;
  name: string;
  counts: Record<Marker, number>;
  rows: number;
};

function newCounts(): Record<Marker, number> {
  return { "✅": 0, "🔁": 0, "➕": 0, "⬜": 0, "✂️": 0, "❓": 0 };
}

const sections: Section[] = [];
let current: Section | null = null;

const surfaceHeader = /^### (\d{2})\.\s(.+)$/;
const flowHeader = /^### FLOW-(\d+)\.\s(.+)$/;

for (const line of lines) {
  const flowMatch = line.match(flowHeader);
  const surfaceMatch = !flowMatch ? line.match(surfaceHeader) : null;

  if (flowMatch) {
    current = { kind: "flow", id: flowMatch[1], name: flowMatch[2], counts: newCounts(), rows: 0 };
    sections.push(current);
    continue;
  }
  if (surfaceMatch) {
    current = { kind: "surface", id: surfaceMatch[1], name: surfaceMatch[2], counts: newCounts(), rows: 0 };
    sections.push(current);
    continue;
  }
  // Any other "### " or "## " header ends the current section's table scope
  // (e.g. moving into Part C / Part D, or a stray subhead).
  if (/^## /.test(line) || (/^### /.test(line) && !flowMatch && !surfaceMatch)) {
    current = null;
    continue;
  }

  if (!current) continue;
  if (!line.startsWith("|")) continue;

  const cells = line.split("|").map((c) => c.trim());
  const dispositionCell = cells.find((c) => MARKERS.some((m) => c.startsWith(m)));
  if (!dispositionCell) continue; // header row / separator row / non-data row

  const marker = MARKERS.find((m) => dispositionCell.startsWith(m))!;
  current.counts[marker]++;
  current.rows++;
}

function realized(c: Record<Marker, number>): string {
  const inScope = c["✅"] + c["🔁"] + c["⬜"] + c["❓"];
  if (inScope === 0) return "—";
  const pct = ((c["✅"] + c["🔁"]) / inScope) * 100;
  return `${pct.toFixed(0)}%`;
}

function inScopeCount(c: Record<Marker, number>): number {
  return c["✅"] + c["🔁"] + c["⬜"] + c["❓"];
}

const surfaces = sections.filter((s) => s.kind === "surface").sort((a, b) => Number(a.id) - Number(b.id));
const flows = sections.filter((s) => s.kind === "flow").sort((a, b) => Number(a.id) - Number(b.id));

console.log("### Per surface (recomputed from Part A detail rows)\n");
console.log("| # | Surface | ✅ | 🔁 | ➕ | ⬜ | ✂️ | ❓ | Rows | Realized% |");
console.log("|---|---|--:|--:|--:|--:|--:|--:|--:|--:|");
for (const s of surfaces) {
  const c = s.counts;
  const shortName = s.name.split(" — ")[0];
  console.log(
    `| ${s.id} | ${shortName} | ${c["✅"]} | ${c["🔁"]} | ${c["➕"]} | ${c["⬜"]} | ${c["✂️"]} | ${c["❓"]} | ${s.rows} | ${realized(c)} |`
  );
}

console.log("\n### Per flow (recomputed from Part B detail rows)\n");
console.log("| # | Flow | ✅ | 🔁 | ➕ | ⬜ | ✂️ | ❓ | Rows |");
console.log("|---|---|--:|--:|--:|--:|--:|--:|--:|");
for (const f of flows) {
  const c = f.counts;
  const shortName = f.name.split(": ")[1] ?? f.name;
  console.log(`| ${f.id} | ${shortName} | ${c["✅"]} | ${c["🔁"]} | ${c["➕"]} | ${c["⬜"]} | ${c["✂️"]} | ${c["❓"]} | ${f.rows} |`);
}

function sum(secs: Section[]): Record<Marker, number> {
  const total = newCounts();
  for (const s of secs) for (const m of MARKERS) total[m] += s.counts[m];
  return total;
}

const surfaceTotal = sum(surfaces);
const flowTotal = sum(flows);
const grandTotal = sum(sections);

const surfaceRows = surfaces.reduce((n, s) => n + s.rows, 0);
const flowRows = flows.reduce((n, s) => n + s.rows, 0);

console.log("\n### Totals\n");
console.log("| Scope | ✅ built | 🔁 adapted | ➕ real-added | ⬜ deferred | ✂️ cut | ❓ missing | Rows | In-scope | Realized% |");
console.log("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
console.log(
  `| Surfaces (30) | ${surfaceTotal["✅"]} | ${surfaceTotal["🔁"]} | ${surfaceTotal["➕"]} | ${surfaceTotal["⬜"]} | ${surfaceTotal["✂️"]} | ${surfaceTotal["❓"]} | ${surfaceRows} | ${inScopeCount(surfaceTotal)} | ${realized(surfaceTotal)} |`
);
console.log(
  `| Flows (8) | ${flowTotal["✅"]} | ${flowTotal["🔁"]} | ${flowTotal["➕"]} | ${flowTotal["⬜"]} | ${flowTotal["✂️"]} | ${flowTotal["❓"]} | ${flowRows} | ${inScopeCount(flowTotal)} | ${realized(flowTotal)} |`
);
console.log(
  `| **Total** | **${grandTotal["✅"]}** | **${grandTotal["🔁"]}** | **${grandTotal["➕"]}** | **${grandTotal["⬜"]}** | **${grandTotal["✂️"]}** | **${grandTotal["❓"]}** | **${surfaceRows + flowRows}** | **${inScopeCount(grandTotal)}** | **${realized(grandTotal)}** |`
);

console.log(`\n(parsed ${sections.length} sections: ${surfaces.length} surfaces + ${flows.length} flows from ${path})`);
