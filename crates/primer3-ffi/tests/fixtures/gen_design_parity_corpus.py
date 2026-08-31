#!/usr/bin/env python3
"""Generate a parity corpus for primer3-ffi's design.rs (the choose_primers
FFI binding) using the real, installed primer3-py library.

Covers the three call shapes Primerool's design modules actually use:
- SEQUENCE_TARGET (primer_internal.py's classic mode)
- SEQUENCE_PRIMER_PAIR_OK_REGION_LIST (main.py's unified design_from_sequence path)
- PRIMER_PICK_INTERNAL_OLIGO (main.py's design_probe / TaqMan mode)
"""
import json
import random

import primer3

rng = random.Random(20260827)
template = "".join(rng.choices("ACGT", k=800))

cases = {}

# -- SEQUENCE_TARGET --
seq_args = {"SEQUENCE_TEMPLATE": template, "SEQUENCE_TARGET": [300, 20]}
global_args = {
    "PRIMER_OPT_SIZE": 20, "PRIMER_MIN_SIZE": 18, "PRIMER_MAX_SIZE": 25,
    "PRIMER_OPT_TM": 62.0, "PRIMER_MIN_TM": 57.0, "PRIMER_MAX_TM": 67.0,
    "PRIMER_MIN_GC": 40.0, "PRIMER_MAX_GC": 60.0,
    "PRIMER_NUM_RETURN": 5,
    "PRIMER_SALT_MONOVALENT": 50.0, "PRIMER_SALT_DIVALENT": 1.5,
    "PRIMER_DNTP_CONC": 0.2, "PRIMER_DNA_CONC": 50.0,
    "PRIMER_PRODUCT_SIZE_RANGE": [[100, 1000]],
}
cases["sequence_target"] = primer3.bindings.design_primers(seq_args, global_args)

# -- SEQUENCE_PRIMER_PAIR_OK_REGION_LIST --
fwd_region = template[50:90]
rev_region = template[300:340]
fwd_pos = template.find(fwd_region)
rev_pos = template.find(rev_region)
seq_args2 = {
    "SEQUENCE_TEMPLATE": template,
    "SEQUENCE_PRIMER_PAIR_OK_REGION_LIST": [[fwd_pos, len(fwd_region), rev_pos, len(rev_region)]],
}
global_args2 = dict(global_args)
global_args2["PRIMER_PRODUCT_SIZE_RANGE"] = [[max(50, 250 - 50), 250 + 50]]
cases["ok_region_list"] = primer3.bindings.design_primers(seq_args2, global_args2)

# -- PRIMER_PICK_INTERNAL_OLIGO (probe) --
probe_region = template[150:250]
seq_args3 = {"SEQUENCE_TEMPLATE": probe_region}
global_args3 = {
    "PRIMER_PICK_LEFT_PRIMER": 0, "PRIMER_PICK_RIGHT_PRIMER": 0, "PRIMER_PICK_INTERNAL_OLIGO": 1,
    "PRIMER_INTERNAL_MIN_TM": 65.0, "PRIMER_INTERNAL_OPT_TM": 70.0, "PRIMER_INTERNAL_MAX_TM": 75.0,
    "PRIMER_INTERNAL_MIN_SIZE": 18, "PRIMER_INTERNAL_OPT_SIZE": 22, "PRIMER_INTERNAL_MAX_SIZE": 30,
    "PRIMER_INTERNAL_MIN_GC": 30.0, "PRIMER_INTERNAL_MAX_GC": 80.0,
    "PRIMER_INTERNAL_SALT_MONOVALENT": 50.0, "PRIMER_INTERNAL_DNA_CONC": 50.0,
    "PRIMER_NUM_RETURN": 5,
}
cases["probe"] = primer3.bindings.design_primers(seq_args3, global_args3)

out = {"template": template, "fwd_region": fwd_region, "rev_region": rev_region, "fwd_pos": fwd_pos, "rev_pos": rev_pos, "probe_region": probe_region, "cases": cases}
print(json.dumps(out))
