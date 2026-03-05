from typing import Dict, Any, Optional
import primer3


def _round_or_none(x, nd=1):
    if x is None:
        return None
    try:
        return round(float(x), nd)
    except Exception:
        return None


def _oligo_gc(seq: str) -> float:
    seq = (seq or "").upper()
    if not seq:
        return 0.0
    gc = sum(1 for b in seq if b in ("G", "C"))
    return 100.0 * gc / len(seq)


def _thermo_kwargs(therm_params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    therm_params = therm_params or {}
    return {
        "mv_conc": therm_params.get("mv_conc", 50.0),
        "dv_conc": therm_params.get("dv_conc", 1.5),
        "dntp_conc": therm_params.get("dntp_conc", 0.2),
        "dna_conc": therm_params.get("dna_conc", 50.0),
    }


def analyze_primer(seq: str, therm_params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    seq = (seq or "").upper().replace(" ", "")
    kwargs = _thermo_kwargs(therm_params)

    try:
        tm = primer3.bindings.calc_tm(seq, **kwargs)
    except TypeError:
        tm = primer3.bindings.calc_tm(seq)

    try:
        hp = primer3.bindings.calc_hairpin(seq, **kwargs)
    except TypeError:
        hp = primer3.bindings.calc_hairpin(seq)

    try:
        hd = primer3.bindings.calc_homodimer(seq, **kwargs)
    except TypeError:
        hd = primer3.bindings.calc_homodimer(seq)

    return {
        "sequence": seq,
        "length": len(seq),
        "gc_percent": _round_or_none(_oligo_gc(seq), 1),
        "tm": _round_or_none(tm, 1),
        "hairpin": {
            "structure_found": bool(getattr(hp, "structure_found", False)),
            "tm": _round_or_none(getattr(hp, "tm", None), 1),
            "dg": _round_or_none(getattr(hp, "dg", None), 1),
        },
        "homodimer": {
            "structure_found": bool(getattr(hd, "structure_found", False)),
            "tm": _round_or_none(getattr(hd, "tm", None), 1),
            "dg": _round_or_none(getattr(hd, "dg", None), 1),
        },
    }


def analyze_pair(fwd_seq: str, rev_seq: str, therm_params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    fwd_seq = (fwd_seq or "").upper().replace(" ", "")
    rev_seq = (rev_seq or "").upper().replace(" ", "")
    kwargs = _thermo_kwargs(therm_params)

    try:
        het = primer3.bindings.calc_heterodimer(fwd_seq, rev_seq, **kwargs)
    except TypeError:
        het = primer3.bindings.calc_heterodimer(fwd_seq, rev_seq)

    return {
        "heterodimer": {
            "structure_found": bool(getattr(het, "structure_found", False)),
            "tm": _round_or_none(getattr(het, "tm", None), 1),
            "dg": _round_or_none(getattr(het, "dg", None), 1),
        }
    }


def default_primer3_args() -> Dict[str, Any]:
    # Keep ONE source of truth for constraints
    return {
        "PRIMER_OPT_SIZE": 20,
        "PRIMER_MIN_SIZE": 18,
        "PRIMER_MAX_SIZE": 25,
        "PRIMER_OPT_TM": 62.0,
        "PRIMER_MIN_TM": 57.0,
        "PRIMER_MAX_TM": 67.0,
        "PRIMER_MIN_GC": 40.0,
        "PRIMER_MAX_GC": 60.0,
        "PRIMER_NUM_RETURN": 5,
        "PRIMER_EXPLAIN_FLAG": 1,
        "PRIMER_PICK_INTERNAL_OLIGO": 0,
    }