#!/usr/bin/env python3
"""Generate a parity corpus using the real, installed primer3-py library,
for cross-checking against Primerool's primer3-ffi Rust FFI binding.

primer3-ffi binds primer3-py's own vendored ("flex") C sources directly
(not a from-scratch reimplementation), so this checks that the Rust FFI
plumbing/calling-convention is correct, not that the underlying math is
correct (that's primer3's own, already-validated, job).
"""
import json
import random

import primer3

rng = random.Random(20260826)
seqs = ["".join(rng.choices("ACGT", k=rng.randint(18, 40))) for _ in range(150)]
# A separate corpus of shorter oligos for heterodimer pairing (two
# independent sequences per case).
pairs = [
    (
        "".join(rng.choices("ACGT", k=rng.randint(18, 30))),
        "".join(rng.choices("ACGT", k=rng.randint(18, 30))),
    )
    for _ in range(60)
]

CONDITIONS = [
    {"mv_conc": 50.0, "dv_conc": 1.5, "dntp_conc": 0.2, "dna_conc": 50.0},
    {"mv_conc": 50.0, "dv_conc": 3.0, "dntp_conc": 0.6, "dna_conc": 200.0},
    {"mv_conc": 20.0, "dv_conc": 0.0, "dntp_conc": 0.0, "dna_conc": 25.0},
]

results = {"tm": [], "hairpin": [], "homodimer": [], "heterodimer": []}

for seq in seqs:
    for cond in CONDITIONS:
        tm = primer3.bindings.calc_tm(seq, **cond)
        results["tm"].append({"seq": seq, **cond, "tm": tm})

        hp = primer3.bindings.calc_hairpin(seq, **cond)
        results["hairpin"].append({
            "seq": seq, **cond,
            "structure_found": hp.structure_found,
            "tm": hp.tm,
            "dg": hp.dg,
        })

        hd = primer3.bindings.calc_homodimer(seq, **cond)
        results["homodimer"].append({
            "seq": seq, **cond,
            "structure_found": hd.structure_found,
            "tm": hd.tm,
            "dg": hd.dg,
        })

for seq1, seq2 in pairs:
    cond = CONDITIONS[0]
    het = primer3.bindings.calc_heterodimer(seq1, seq2, **cond)
    results["heterodimer"].append({
        "seq1": seq1, "seq2": seq2, **cond,
        "structure_found": het.structure_found,
        "tm": het.tm,
        "dg": het.dg,
    })

print(json.dumps(results))
