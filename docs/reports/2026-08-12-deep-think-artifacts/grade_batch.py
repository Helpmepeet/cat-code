#!/usr/bin/env python3
"""Grade a claude -p --output-format json run against bench.json (external benchmark items).

Expects the model to emit lines like:
    Q1: 247
    Q2: D
Normalises integers, MCQ letters, and simple expressions before comparing.
"""
import json, re, sys, os

SB = os.path.dirname(os.path.abspath(__file__))
BENCH = json.load(open(os.path.join(SB, os.environ.get("BENCH_FILE","bench.json"))))


def norm(s, kind):
    s = (s or "").strip()
    s = s.strip("$ \t.,;:*`")
    if kind == "integer":
        m = re.search(r"-?\d+", s.replace(",", ""))
        return str(int(m.group())) if m else None
    if kind == "mcq":
        m = re.search(r"\b([A-Ea-e])\b", s)
        return m.group(1).upper() if m else None
    # expression: aggressive whitespace/format normalisation
    s = s.lower().replace(" ", "").replace("\\left", "").replace("\\right", "")
    s = s.replace("\\dfrac", "\\frac").replace("{}", "")
    return s or None


def load(path):
    raw = open(path).read()
    i = raw.find("[")
    if i < 0:
        i = raw.find("{")
    return json.loads(raw[i:])


def grade(path, label, verbose=False):
    items = load(path)
    items = items if isinstance(items, list) else [items]
    res = [x for x in items if x.get("type") == "result"][0]
    text = res.get("result") or ""

    calls, scratch = [], 0
    for it in items:
        for b in ((it.get("message") or {}).get("content") or []):
            if isinstance(b, dict) and b.get("type") == "tool_use":
                calls.append(b.get("name"))
                scratch += len((b.get("input") or {}).get("reasoning", "") or "")

    u = res["usage"]
    tt = u["output_tokens_details"]["thinking_tokens"]

    ok, tot, misses = 0, 0, []
    for idx, item in enumerate(BENCH, 1):
        tot += 1
        m = re.search(rf"^\s*Q?{idx}\s*[:.)]\s*(.+)$", text, re.M)
        got = norm(m.group(1), item["answer_type"]) if m else None
        want = norm(item["answer"], item["answer_type"])
        if got is not None and got == want:
            ok += 1
        else:
            misses.append(f"Q{idx}(got={got!r},want={want!r})")

    # F2 fix: format compliance must inspect EVERY assistant text block, not
    # just the final result. A preamble before a tool call is a violation the
    # old grader could not see.
    extra = []
    for it in items:
        m2 = it.get("message") or {}
        if m2.get("role") != "assistant":
            continue
        for b in (m2.get("content") or []):
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip():
                t = b["text"].strip()
                if t not in text:
                    extra.append(t)
    leaked = bool(re.search(r"<thinking>|<scratchpad>", text, re.I))
    fmt_ok = (not leaked) and not extra
    print(f"{label:<34} {ok:>2}/{tot} ({100*ok//max(tot,1):>3}%) | think_tok {tt:>6} | "
          f"scratch {scratch:>6} | turns {res['num_turns']} | ${res['total_cost_usd']:.3f} | "
          f"fmt {'OK ' if fmt_ok else 'VIOL'} | tools {sorted(set(calls)) or 'none'}")
    for t in extra:
        print(f"      format violation (text outside answer): {t[:90]!r}")
    if verbose and misses:
        print("      missed:", ", ".join(misses[:12]))
    return {"label": label, "ok": ok, "tot": tot, "think_tok": tt, "scratch": scratch}


if __name__ == "__main__":
    verbose = "-v" in sys.argv
    args = [a for a in sys.argv[1:] if a != "-v"]
    for p, l in zip(args[0::2], args[1::2]):
        grade(p, l, verbose)
