#!/usr/bin/env python3
"""Grade a claude -p --output-format json run against puzzles5h.json.

Reports: exact-puzzle score, per-cell score (12 or 15 cells per puzzle, set-dependent), reasoning volume,
and which tools actually fired.
"""
import json, re, sys, os

SB = os.path.dirname(os.path.abspath(__file__))
PUZ = json.load(open(os.path.join(SB, "puzzles5h.json")))

def load(path):
    raw = open(path).read()
    i = raw.find("[")
    if i < 0:
        i = raw.find("{")
    return json.loads(raw[i:])

def grade(path, label):
    items = load(path)
    items = items if isinstance(items, list) else [items]
    res = [x for x in items if x.get("type") == "result"][0]
    text = res.get("result") or ""

    calls, think_chars = [], 0
    for it in items:
        for b in ((it.get("message") or {}).get("content") or []):
            if isinstance(b, dict) and b.get("type") == "tool_use":
                calls.append(b.get("name"))
                inp = b.get("input") or {}
                think_chars += len(inp.get("reasoning", "") or "")

    u = res["usage"]
    tt = u["output_tokens_details"]["thinking_tokens"]

    exact = 0
    cells_ok = 0
    cells_tot = 0
    per = []
    for idx, p in enumerate(PUZ, 1):
        m = re.search(rf"^P{idx}\s*:(.*)$", text, re.M)
        sol = p["sol"]
        got = {}
        if m:
            for h, o, pe, d in re.findall(r"(\d)\s*=\s*(\w+)\s*/\s*(\w+)\s*/\s*(\w+)", m.group(1)):
                got[int(h)] = (o.lower(), pe.lower(), d.lower())
        ok_cells = 0
        for h in range(1, 6):
            truth = (sol["owners"][h-1].lower(), sol["pets"][h-1].lower(), sol["doors"][h-1].lower())
            g = got.get(h, ("", "", ""))
            for j in range(3):
                cells_tot += 1
                if g[j] == truth[j]:
                    cells_ok += 1
                    ok_cells += 1
        per.append(ok_cells)
        if ok_cells == 15:
            exact += 1

    print(f"{label:<38} exact {exact:>2}/{len(PUZ)} | cells {cells_ok:>3}/{cells_tot} "
          f"({100*cells_ok//cells_tot:>3}%) | think_tok {tt:>5} | scratch_chars {think_chars:>6} "
          f"| turns {res['num_turns']} | ${res['total_cost_usd']:.3f} | tools {sorted(set(calls)) or 'none'}")
    return {"label": label, "exact": exact, "cells": cells_ok, "think_tok": tt,
            "scratch_chars": think_chars, "per": per}

if __name__ == "__main__":
    out = [grade(p, l) for p, l in zip(sys.argv[1::2], sys.argv[2::2])]
    json.dump(out, open(os.path.join(SB, "grades.json"), "w"), indent=1)
