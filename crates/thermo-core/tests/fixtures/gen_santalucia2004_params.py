"""Generate `data/santalucia2004-dna.json`: Strider's native (SantaLucia 2004)
DNA parameter set in the same `{"dG": ..., "dH": ...}` shape as
`mathews2004-dna.json`.

The `dG` section is empty on purpose: Strider's native ΔG path runs with no
parameter override, so every ΔG lookup falls back to the native tables
(`crate::tables::dna`), exactly like a missing section in the Mathews JSON.
The `dH` section is Strider's own `load_parameters("native").dH`, the table
`structure_enthalpy`/`structure_enthalpy_dimer` use when no parameter set is
given; any table it omits falls back to the native ΔG table, mirroring
`lookup_table`.

Run against the Strider Oligool depends on:

    python crates/thermo-core/tests/fixtures/gen_santalucia2004_params.py
"""

import json
from pathlib import Path

import numpy as np
from strider.thermo.parameters import load_parameters


def conv(v):
    if isinstance(v, np.ndarray):
        return [float(x) for x in v]
    if isinstance(v, dict):
        return {k: float(x) for k, x in v.items()}
    return float(v)


ps = load_parameters("native")
out = {"dG": {}, "dH": {k: conv(v) for k, v in ps.dH.items()}}
path = Path(__file__).resolve().parents[2] / "data" / "santalucia2004-dna.json"
path.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
