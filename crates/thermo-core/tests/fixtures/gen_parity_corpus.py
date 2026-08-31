#!/usr/bin/env python3
"""Generate a parity corpus using Strider's pure-Python thermo functions
(native extension blocked), for cross-checking against Primerool's
thermo-core Rust port. Mirrors the blocking technique in
strider/scripts/bench_native.py.
"""
import importlib.abc
import importlib.machinery
import json
import random
import sys

sys.path.insert(0, "/home/kowalski/Work/strider")


class _Blocker(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path, target=None):
        if fullname == "strider._native":
            return importlib.machinery.ModuleSpec(fullname, self)
        return None

    def create_module(self, spec):
        raise ImportError("strider._native blocked for pure-python parity corpus")

    def exec_module(self, module):
        pass


sys.meta_path.insert(0, _Blocker())

from strider.thermo import nn_dna, salt  # noqa: E402

assert nn_dna._n is None, "pure-python oracle tainted: native resolved anyway"

rng = random.Random(1234)
seqs = ["".join(rng.choices("ACGT", k=rng.randint(15, 40))) for _ in range(200)]

results = []
for seq in seqs:
    dh, ds = nn_dna.duplex_dh_ds(seq)
    tm_default = nn_dna.melting_temperature(seq)
    tm_salty = nn_dna.melting_temperature(seq, strand_conc_M=400e-9, sodium_M=0.1958, magnesium_M=0.0)
    duplex_tm_default = nn_dna.duplex_tm(seq)
    dg_default = nn_dna.duplex_dg(seq)
    owczarzy = salt.owczarzy_tm_correction(seq, 0.1958, 0.0)
    owczarzy_mg = salt.owczarzy_tm_correction(seq, 0.05, 0.003)
    dg_per_bp = salt.dg_per_bp_salt(0.05, 0.0022, 37.0, "dna")
    rc = nn_dna.reverse_complement(seq)
    selfcomp = nn_dna.is_self_complementary(seq)
    results.append({
        "seq": seq,
        "dh": dh, "ds": ds,
        "tm_default": tm_default,
        "tm_salty": tm_salty,
        "duplex_tm_default": duplex_tm_default,
        "dg_default": dg_default,
        "owczarzy": owczarzy,
        "owczarzy_mg": owczarzy_mg,
        "dg_per_bp": dg_per_bp,
        "reverse_complement": rc,
        "is_self_complementary": selfcomp,
    })

# A couple of Tan-Chen and dimer sanity spot-checks too.
tan_chen_cases = []
for n_pairs, na, mg in [(10.0, 0.05, 0.0), (20.0, 0.1, 0.01), (8.0, 0.15, 0.0)]:
    from strider.thermo import dimer_thermo  # noqa: E402
    tan_chen_cases.append({
        "n_pairs": n_pairs, "na": na, "mg": mg,
        "value": salt.tan_chen_helix_dg(n_pairs, na, mg, "dna"),
    })

out = {"results": results, "tan_chen_cases": tan_chen_cases}
print(json.dumps(out))
