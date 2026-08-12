#!/usr/bin/env python3
"""Generate 5-house / 3-category puzzles with VERIFIED-UNIQUE solutions and
MINIMAL clue sets (every clue load-bearing). Minimal => maximum deduction depth,
which is the difficulty knob that matters. Uses numpy masks over the full
1,728,000-state space so trimming is cheap.
"""
import itertools, json, random
import numpy as np

NAMES = ["Ana", "Ben", "Cy", "Dee", "Eli"]
PETS = ["cat", "dog", "fish", "bird", "rat"]
DOORS = ["red", "blue", "green", "white", "black"]
N = 5

perms = list(itertools.permutations(range(N)))
P = len(perms)                      # 120
parr = np.array(perms, dtype=np.int8)

# full cross product of (owner-perm, pet-perm, door-perm)
oi, pi, di = np.meshgrid(np.arange(P), np.arange(P), np.arange(P), indexing="ij")
oi, pi, di = oi.ravel(), pi.ravel(), di.ravel()
O = parr[oi]        # (M,5) owner index at house h
Pe = parr[pi]
D = parr[di]
M = O.shape[0]

def invert(A):
    """position of each label: pos[:,k] = house index where label k sits"""
    out = np.empty_like(A)
    rows = np.arange(A.shape[0])[:, None]
    out[rows, A] = np.arange(N)[None, :]
    return out

posO, posPe, posD = invert(O), invert(Pe), invert(D)
ROWS = np.arange(M)


def build_pool(owners, pets, doors, rng):
    """(text, mask) for every true statement about this solution."""
    pool = []
    for i in range(N):
        o, pt, dr = owners[i], pets[i], doors[i]
        pool.append((f"{NAMES[o]} lives in house {i+1}", O[:, i] == o))
        pool.append((f"The {PETS[pt]} owner lives in house {i+1}", Pe[:, i] == pt))
        pool.append((f"The {DOORS[dr]} door is house {i+1}", D[:, i] == dr))
        pool.append((f"{NAMES[o]} owns the {PETS[pt]}", Pe[ROWS, posO[:, o]] == pt))
        pool.append((f"{NAMES[o]} has the {DOORS[dr]} door", D[ROWS, posO[:, o]] == dr))
        pool.append((f"The {PETS[pt]} owner has the {DOORS[dr]} door", D[ROWS, posPe[:, pt]] == dr))
    for i in range(N - 1):
        a, b = owners[i], owners[i + 1]
        pool.append((f"{NAMES[a]} lives immediately left of {NAMES[b]}", posO[:, a] + 1 == posO[:, b]))
        a, b = pets[i], pets[i + 1]
        pool.append((f"The {PETS[a]} owner lives immediately left of the {PETS[b]} owner",
                     posPe[:, a] + 1 == posPe[:, b]))
        a, b = doors[i], doors[i + 1]
        pool.append((f"The {DOORS[a]} door is immediately left of the {DOORS[b]} door",
                     posD[:, a] + 1 == posD[:, b]))
    # negatives
    for i in range(N):
        o = owners[i]
        for pt in range(N):
            if pets[i] != pt:
                pool.append((f"{NAMES[o]} does not own the {PETS[pt]}", Pe[ROWS, posO[:, o]] != pt))
        for dr in range(N):
            if doors[i] != dr:
                pool.append((f"{NAMES[o]} does not have the {DOORS[dr]} door", D[ROWS, posO[:, o]] != dr))
    rng.shuffle(pool)
    return pool


def count(masks):
    if not masks:
        return M
    m = masks[0].copy()
    for x in masks[1:]:
        m &= x
    return int(m.sum())


def gen(seed, max_clues):
    rng = random.Random(seed)
    owners = list(range(N)); rng.shuffle(owners)
    pets = list(range(N)); rng.shuffle(pets)
    doors = list(range(N)); rng.shuffle(doors)
    pool = build_pool(owners, pets, doors, rng)

    chosen = []
    cur = np.ones(M, dtype=bool)
    for text, mask in pool:
        nxt = cur & mask
        if nxt.sum() == cur.sum():
            continue                      # adds nothing
        cur = nxt
        chosen.append((text, mask))
        if cur.sum() == 1:
            break
        if len(chosen) > 14:
            return None
    if cur.sum() != 1:
        return None

    # trim to a minimal set: drop any clue whose removal keeps uniqueness
    changed = True
    while changed:
        changed = False
        for k in range(len(chosen)):
            sub = chosen[:k] + chosen[k + 1:]
            if count([m for _, m in sub]) == 1:
                chosen = sub
                changed = True
                break
    if len(chosen) > max_clues:
        return None
    return {"clues": [t for t, _ in chosen],
            "sol": {"owners": [NAMES[x] for x in owners],
                    "pets": [PETS[x] for x in pets],
                    "doors": [DOORS[x] for x in doors]}}


if __name__ == "__main__":
    out, seed = [], 0
    while len(out) < 10 and seed < 4000:
        seed += 1
        p = gen(5000 + seed, max_clues=9)
        if p:
            out.append(p)
    print("generated", len(out), "minimal puzzles; clue counts:", [len(p["clues"]) for p in out])
    json.dump(out, open("/private/tmp/claude-501/-Users-pt-cat-code/cde27359-d467-42af-a056-546d27e12279/scratchpad/puzzles5h.json", "w"), indent=1)
