"""Generate `tests/mathews2004_corpus.json`.

Run against the actual strider fork Oligool depends on — Primerool has no
runtime dependency on it, this script is a one-time oracle:

    pip install "strider-dna @ git+https://github.com/KowalskiBio/strider.git@mathews2004-dangles"
    python crates/thermo-core/tests/fixtures/gen_mathews2004_corpus.py \
        > crates/thermo-core/tests/mathews2004_corpus.json

Exercises `strider.thermo.hairpin.hairpin_thermo` and
`strider.thermo.dimer_thermo.{dimer_thermo,dimer_thermo_subopt}` with
`parameter_set="mathews2004-dna"` (Oligool's own default) across varied
sequence lengths/compositions — including ones with 1x1/1x2/2x2 interior
loops and bulges — so `mathews2004_parity.rs` has real per-element coverage,
not just perfect-stem cases.
"""

import json
import random

from strider.thermo.hairpin import hairpin_thermo
from strider.thermo.dimer_thermo import dimer_thermo, dimer_thermo_subopt
from strider.thermo.structure_thermo import parse_hairpin_pairs, parse_dimer_pairs

# Primerool's hairpin/dimer DP (crates/thermo-core/src/{hairpin,dimer,
# mathews2004_fold}.rs) is documented as single-stem-only with interior
# loops/bulges capped at 4 unpaired bases per side (MAX_LOOP=4) -- a
# deliberate pre-existing scope limit ("NOT general multi-branch MFE
# structure prediction"), not something this corpus is meant to test past.
# The full fork's `fold_mfe` is a general multi-branch Zuker DP with no such
# cap, so on longer/more complex sequences it can legitimately find a
# structure with a bigger interior loop that Primerool's DP cannot represent
# at all. Filter those out here rather than let the golden-fixture test fail
# on a case outside what the ported engine claims to support.
MAX_LOOP = 4


def within_scope(pairs) -> bool:
    for (i, j), (ip, jp) in zip(pairs, pairs[1:]):
        nl, nr = ip - i - 1, j - jp - 1
        if nl > MAX_LOOP or nr > MAX_LOOP:
            return False
    return True

random.seed(1234)
BASES = "ACGT"


def random_seq(n: int) -> str:
    return "".join(random.choice(BASES) for _ in range(n))


def hairpin_seq(stem_len: int, loop: str, bulge: str = "") -> str:
    stem = random_seq(stem_len)
    comp = {"A": "T", "T": "A", "C": "G", "G": "C"}
    rc = "".join(comp[b] for b in reversed(stem))
    if bulge:
        half = len(stem) // 2
        return stem[:half] + bulge + stem[half:] + loop + rc
    return stem + loop + rc


hairpin_seqs = [
    "GCGCGCGAAACGCGCGC",
    "AAAGCTTGCAAAGCAAGCTTT",
    "CGATCGATCTTTTGATCGATCG",
    "GGGGAAACCCC",
    "ACGTACGTGGGAAACCCACGTACGT",
    hairpin_seq(8, "GAAA"),
    hairpin_seq(10, "CTTCG"),
    hairpin_seq(6, "TTTT", bulge="A"),  # single-base bulge
    hairpin_seq(7, "GCAA", bulge="AA"),  # 2nt bulge
    hairpin_seq(9, "TTCG"),
]
for _ in range(60):
    hairpin_seqs.append(random_seq(random.randint(14, 36)))

dimer_pairs = [
    ("ACGTACGTACGT", "ACGTACGTACGT"),
    ("GATCGGAAGAGCACACGTCT", "AGACGTGTGCTCTTCCGATC"),
    ("AAAAACCCCC", "GGGGGTTTTT"),
    ("CTGCAGCTGCAG", None),
    ("ACGT", "ACGT"),
    ("GCGCGC", "GCGCGC"),
    ("GCACTACAACCGCTACCGTG", None),  # from the fork's own dG-rescale docstring example
]
for _ in range(60):
    n = random.randint(10, 28)
    dimer_pairs.append((random_seq(n), None))
    dimer_pairs.append((random_seq(n), random_seq(n)))
# Homopolymer / low-complexity runs deliberately included — these are the
# cases that actually caught real bugs (dangle contributions omitted from
# the candidate-ranking DP) during development; keep them in the corpus.
for base in "ACGT":
    dimer_pairs.append((base * 8, None))
    dimer_pairs.append((base * 10, {"A": "T", "T": "A", "C": "G", "G": "C"}[base] * 10))

cases = []
for s in hairpin_seqs:
    try:
        h = hairpin_thermo(s, sodium_M=0.05, magnesium_M=0.003, material="dna", paramset="mathews2004-dna", dangles=2)
        if not within_scope(parse_hairpin_pairs(h.structure)):
            continue
        cases.append(
            {
                "kind": "hairpin",
                "seq": s,
                "tm": h.tm_celsius,
                "dh": h.dH,
                "ds": h.dS,
                "dg37": h.dG37,
                "n_pairs": h.n_pairs,
                "structure": h.structure,
            }
        )
    except ValueError:
        continue  # no fold / degenerate entropy — not a useful fixture case

for s1, s2 in dimer_pairs:
    try:
        d = dimer_thermo(s1, s2, sodium_M=0.05, magnesium_M=0.003, material="dna", strand_conc_M=250e-9, paramset="mathews2004-dna", dangles=0)
        if not within_scope(parse_dimer_pairs(d.structure, len(s1))):
            continue
    except ValueError:
        continue
    subopt = dimer_thermo_subopt(s1, s2, n=5, sodium_M=0.05, magnesium_M=0.003, material="dna", strand_conc_M=250e-9, paramset="mathews2004-dna", dangles=0)
    if not all(within_scope(parse_dimer_pairs(s.structure, len(s1))) for s in subopt):
        continue
    cases.append(
        {
            "kind": "dimer",
            "seq1": s1,
            "seq2": s2,
            "tm": d.tm_celsius,
            "dh": d.dH,
            "ds": d.dS,
            "dg37": d.dG37,
            "n_pairs": d.n_pairs,
            "structure": d.structure,
            "is_self_dimer": d.is_self_dimer,
            "subopt": [
                {"tm": s.tm_celsius, "dh": s.dH, "ds": s.dS, "dg37": s.dG37, "n_pairs": s.n_pairs, "structure": s.structure}
                for s in subopt
            ],
        }
    )

print(json.dumps({"cases": cases}, indent=2))
