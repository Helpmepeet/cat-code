#!/usr/bin/env python3
"""GPT arm of the deep_think experiment.

Three conditions over the 15 post-cutoff competition problems, one call per
problem (each problem gets its own budget, matching the Claude solo design):

  A  native reasoning only, effort low, no tools
  B  native reasoning + deep_think, explicitly instructed to use it
  H  native reasoning only, effort high, no tools   (headroom reference)

Note the premise gap: GPT-5.x on this backend has NO "none"/"disabled"
reasoning level -- the floor is "low". So the Claude condition "thinking off"
is not expressible here, and that is itself a finding.
"""
import json, os, sys, time
import gpt_client as g

SB = os.path.dirname(os.path.abspath(__file__))
BENCH = json.load(open(f"{SB}/bench.json"))
MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt-5.6-sol"

FORCE = ("You have a tool called deep_think. You MUST call deep_think exactly once with your full "
         "step-by-step reasoning in the `reasoning` argument BEFORE answering. Then give only the "
         "final answer line.\n\n")

CONDS = {
    "A_low_notool":  dict(tools=[],             effort="low",  prefix=""),
    "B_low_tool":    dict(tools=g.DEEP_THINK,   effort="low",  prefix=FORCE),
    "H_high_notool": dict(tools=[],             effort="high", prefix=""),
}


def norm(s):
    import re
    m = re.search(r"-?\d+", (s or "").replace(",", ""))
    return str(int(m.group())) if m else None


def main():
    out = {}
    for cname, cfg in CONDS.items():
        rows, ok = [], 0
        for i, item in enumerate(BENCH, 1):
            task = open(f"{SB}/task_solo{i}.txt").read()
            t0 = time.time()
            r = g.run_loop(MODEL, cfg["prefix"] + task, cfg["tools"], cfg["effort"])
            got = norm(r["text"].split(":")[-1] if ":" in r["text"] else r["text"])
            want = norm(item["answer"])
            hit = got == want
            ok += hit
            scratch = 0
            for c in r["calls"]:
                try:
                    scratch += len(json.loads(c["arguments"]).get("reasoning", ""))
                except Exception:
                    scratch += len(c["arguments"])
            rows.append({"q": i, "id": item["id"], "got": got, "want": want, "hit": hit,
                         "calls": [c["name"] for c in r["calls"]],
                         "reasoning_tokens": r["reasoning_tokens"],
                         "output_tokens": r["output_tokens"],
                         "scratch_chars": scratch, "turns": r["turns"],
                         "secs": round(time.time() - t0, 1),
                         "errors": r["errors"]})
            print(f"{cname} Q{i:<2} {'OK ' if hit else 'MISS'} got={got} want={want} "
                  f"rtok={r['reasoning_tokens']} calls={len(r['calls'])} {rows[-1]['secs']}s", flush=True)
        out[cname] = {"score": ok, "n": len(BENCH), "rows": rows}
        print(f"== {cname}: {ok}/{len(BENCH)} ==", flush=True)
        json.dump(out, open(f"{SB}/gpt_results.json", "w"), indent=1)
    print(json.dumps({k: f"{v['score']}/{v['n']}" for k, v in out.items()}, indent=1))


if __name__ == "__main__":
    main()
