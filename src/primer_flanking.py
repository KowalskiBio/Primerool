# primer_flanking.py
from typing import Dict, Any, Optional
import primer3

from primer_utils import analyze_primer, analyze_pair, default_primer3_args, _round_or_none


def design_primers_for_flanking_regions(
    upstream_seq: str,
    downstream_seq: str,
    primer_params: Optional[Dict[str, Any]] = None,
    flank_window: Optional[int] = None,
    therm_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    WGA / whole-gene amplification:
      - Forward primer: LEFT primer chosen from the LAST `flank_window` bases of upstream flank
      - Reverse primer: RIGHT primer chosen from the FIRST `flank_window` bases of downstream flank

    If flank_window is None, the full flanking sequence is used.
    Uses relaxed GC%/Tm constraints compared to internal primers since
    flanking genomic regions can be AT-rich or GC-rich.
    """

    global_args = default_primer3_args()
    # Relax constraints for flanking/WGA primers — these regions are genomic
    # and often fall outside the 40-60% GC sweet-spot of coding sequence.
    global_args.update({
        "PRIMER_MIN_GC": 20.0,
        "PRIMER_MAX_GC": 80.0,
        "PRIMER_MIN_TM": 52.0,
        "PRIMER_MAX_TM": 68.0,
    })
    if primer_params:
        global_args.update(primer_params)

    results: Dict[str, Any] = {
        "forward": {"num_returned": 0, "primers": [], "explain": ""},
        "reverse": {"num_returned": 0, "primers": [], "explain": ""},
        "pair_metrics": None,
    }

    # -------------------------
    # FORWARD (LEFT) - upstream
    # -------------------------
    if upstream_seq and len(upstream_seq) >= int(global_args.get("PRIMER_MIN_SIZE", 18)):
        upstream_seq = upstream_seq.upper().replace(" ", "")
        up_len = len(upstream_seq)
        win = min(int(flank_window), up_len) if flank_window else up_len
        up_start = up_len - win

        up_args = dict(global_args)
        up_args.update(
            {
                "PRIMER_PICK_LEFT_PRIMER": 1,
                "PRIMER_PICK_RIGHT_PRIMER": 0,
                "PRIMER_PRODUCT_SIZE_RANGE": [[50, 50000]],
            }
        )

        up_res = primer3.design_primers(
            {
                "SEQUENCE_ID": "upstream_flank",
                "SEQUENCE_TEMPLATE": upstream_seq,
                "SEQUENCE_INCLUDED_REGION": [up_start, win],
            },
            up_args,
        )

        n_left = int(up_res.get("PRIMER_LEFT_NUM_RETURNED", 0) or 0)
        results["forward"]["num_returned"] = n_left
        results["forward"]["explain"] = up_res.get("PRIMER_LEFT_EXPLAIN", "")

        for i in range(min(5, n_left)):
            seq = up_res.get(f"PRIMER_LEFT_{i}_SEQUENCE")
            pos = up_res.get(f"PRIMER_LEFT_{i}")  # (start, length)

            a = analyze_primer(seq, therm_params=therm_params)
            a["position_raw"] = pos

            if pos:
                start, length = pos
                start = int(start)
                length = int(length)
                end = start + length
                a["interval"] = [start, end]     # [start,end)
                a["position"] = [start, length]  # [start,length]
            else:
                a["interval"] = None
                a["position"] = None

            a["primer3"] = {
                "tm": _round_or_none(up_res.get(f"PRIMER_LEFT_{i}_TM"), 1),
                "gc_percent": _round_or_none(up_res.get(f"PRIMER_LEFT_{i}_GC_PERCENT"), 1),
                "self_any": _round_or_none(up_res.get(f"PRIMER_LEFT_{i}_SELF_ANY"), 1),
                "self_end": _round_or_none(up_res.get(f"PRIMER_LEFT_{i}_SELF_END"), 1),
                "hairpin_th": _round_or_none(up_res.get(f"PRIMER_LEFT_{i}_HAIRPIN_TH"), 1),
            }

            results["forward"]["primers"].append(a)

    # --------------------------
    # REVERSE (RIGHT) - downstream
    # --------------------------
    if downstream_seq and len(downstream_seq) >= int(global_args.get("PRIMER_MIN_SIZE", 18)):
        downstream_seq = downstream_seq.upper().replace(" ", "")
        down_len = len(downstream_seq)
        win = min(int(flank_window), down_len) if flank_window else down_len

        down_args = dict(global_args)
        down_args.update(
            {
                "PRIMER_PICK_LEFT_PRIMER": 0,
                "PRIMER_PICK_RIGHT_PRIMER": 1,
                "PRIMER_PRODUCT_SIZE_RANGE": [[50, 50000]],
            }
        )

        down_res = primer3.design_primers(
            {
                "SEQUENCE_ID": "downstream_flank",
                "SEQUENCE_TEMPLATE": downstream_seq,
                "SEQUENCE_INCLUDED_REGION": [0, win],
            },
            down_args,
        )

        n_right = int(down_res.get("PRIMER_RIGHT_NUM_RETURNED", 0) or 0)
        results["reverse"]["num_returned"] = n_right
        results["reverse"]["explain"] = down_res.get("PRIMER_RIGHT_EXPLAIN", "")

        for i in range(min(5, n_right)):
            seq = down_res.get(f"PRIMER_RIGHT_{i}_SEQUENCE")
            pos = down_res.get(f"PRIMER_RIGHT_{i}")  # often (right_end, length)

            a = analyze_primer(seq, therm_params=therm_params)
            a["position_raw"] = pos

            if pos:
                right_end, length = pos
                right_end = int(right_end)
                length = int(length)
                start = right_end - length + 1
                end = right_end + 1  # end-exclusive
                a["interval"] = [start, end]     # [start,end)
                a["position"] = [start, length]  # [start,length]
            else:
                a["interval"] = None
                a["position"] = None

            a["primer3"] = {
                "tm": _round_or_none(down_res.get(f"PRIMER_RIGHT_{i}_TM"), 1),
                "gc_percent": _round_or_none(down_res.get(f"PRIMER_RIGHT_{i}_GC_PERCENT"), 1),
                "self_any": _round_or_none(down_res.get(f"PRIMER_RIGHT_{i}_SELF_ANY"), 1),
                "self_end": _round_or_none(down_res.get(f"PRIMER_RIGHT_{i}_SELF_END"), 1),
                "hairpin_th": _round_or_none(down_res.get(f"PRIMER_RIGHT_{i}_HAIRPIN_TH"), 1),
            }

            results["reverse"]["primers"].append(a)

    # Pair metrics (best #1/#1)
    if results["forward"]["primers"] and results["reverse"]["primers"]:
        f0 = results["forward"]["primers"][0]["sequence"]
        r0 = results["reverse"]["primers"][0]["sequence"]
        results["pair_metrics"] = analyze_pair(f0, r0, therm_params=therm_params)

    return results