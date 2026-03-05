# primer_manual.py
from typing import Dict, Any, Optional
import primer3

from primer_utils import analyze_primer, default_primer3_args, _round_or_none


def design_one_primer_in_region(
    template: str,
    include_start: int,
    include_len: int,
    which: str,  # "left" or "right"
    primer_params: Optional[Dict[str, Any]] = None,
    therm_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Design a single LEFT or RIGHT primer constrained to SEQUENCE_INCLUDED_REGION.
    Returns best primer that satisfies the same rules as automatic primers.
    """
    template = (template or "").upper().replace(" ", "")
    if which not in ("left", "right"):
        return {"error": "which must be 'left' or 'right'"}

    if include_start < 0 or include_len <= 0 or include_start + include_len > len(template):
        return {"error": "Invalid include region"}

    args = default_primer3_args()
    if primer_params:
        args.update(primer_params)

    # Force single-primer pick
    args.update({
        "PRIMER_EXPLAIN_FLAG": 1,
        "PRIMER_PICK_LEFT_PRIMER": 1 if which == "left" else 0,
        "PRIMER_PICK_RIGHT_PRIMER": 1 if which == "right" else 0,
        "PRIMER_PICK_INTERNAL_OLIGO": 0,
        "PRIMER_PRODUCT_SIZE_RANGE": [[50, 5000]],
        "PRIMER_NUM_RETURN": 5,
    })

    out = primer3.design_primers(
        {
            "SEQUENCE_ID": f"manual_{which}",
            "SEQUENCE_TEMPLATE": template,
            "SEQUENCE_INCLUDED_REGION": [int(include_start), int(include_len)],
        },
        args,
    )

    if which == "left":
        n = int(out.get("PRIMER_LEFT_NUM_RETURNED", 0) or 0)
        if n == 0:
            return {"error": "No valid LEFT primer found in region", "primer3": out.get("PRIMER_LEFT_EXPLAIN")}

        seq = out.get("PRIMER_LEFT_0_SEQUENCE")
        pos = out.get("PRIMER_LEFT_0")  # (start, length)

        a = analyze_primer(seq, therm_params=therm_params)
        a["position_raw"] = pos

        if pos:
            start, length = pos
            start = int(start); length = int(length)
            a["interval"] = [start, start + length]
            a["position"] = [start, length]
        else:
            a["interval"] = None
            a["position"] = None

        a["primer3"] = {
            "tm": _round_or_none(out.get("PRIMER_LEFT_0_TM"), 1),
            "gc_percent": _round_or_none(out.get("PRIMER_LEFT_0_GC_PERCENT"), 1),
            "self_any": _round_or_none(out.get("PRIMER_LEFT_0_SELF_ANY"), 1),
            "self_end": _round_or_none(out.get("PRIMER_LEFT_0_SELF_END"), 1),
            "hairpin_th": _round_or_none(out.get("PRIMER_LEFT_0_HAIRPIN_TH"), 1),
        }
        return {"design": a}

    # RIGHT
    n = int(out.get("PRIMER_RIGHT_NUM_RETURNED", 0) or 0)
    if n == 0:
        return {"error": "No valid RIGHT primer found in region", "primer3": out.get("PRIMER_RIGHT_EXPLAIN")}

    seq = out.get("PRIMER_RIGHT_0_SEQUENCE")
    pos = out.get("PRIMER_RIGHT_0")  # often (right_end, length)

    a = analyze_primer(seq, therm_params=therm_params)
    a["position_raw"] = pos

    if pos:
        right_end, length = pos
        right_end = int(right_end); length = int(length)
        start = right_end - length + 1
        a["interval"] = [start, right_end + 1]
        a["position"] = [start, length]
    else:
        a["interval"] = None
        a["position"] = None

    a["primer3"] = {
        "tm": _round_or_none(out.get("PRIMER_RIGHT_0_TM"), 1),
        "gc_percent": _round_or_none(out.get("PRIMER_RIGHT_0_GC_PERCENT"), 1),
        "self_any": _round_or_none(out.get("PRIMER_RIGHT_0_SELF_ANY"), 1),
        "self_end": _round_or_none(out.get("PRIMER_RIGHT_0_SELF_END"), 1),
        "hairpin_th": _round_or_none(out.get("PRIMER_RIGHT_0_HAIRPIN_TH"), 1),
    }
    return {"design": a}