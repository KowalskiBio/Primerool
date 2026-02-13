# primer_junction.py - FIXED VERSION
from typing import Dict, Any, Optional, List, Tuple
import primer3

from primer_utils import analyze_primer, analyze_pair, default_primer3_args, _round_or_none


def _parse_right_interval(out: Dict[str, Any], i: int) -> Optional[List[int]]:
    pos = out.get(f"PRIMER_RIGHT_{i}")
    if not pos:
        return None
    right_end, length = pos
    right_end = int(right_end)
    length = int(length)
    start = right_end - length + 1
    end = right_end + 1
    return [start, end]


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def design_junction_primer_pairs(
    template: str,
    junction_pos: int,
    overlap_min: int = 6,
    overlap_max: int = 12,
    product_min: int = 80,
    product_max: int = 220,
    primer_params: Optional[Dict[str, Any]] = None,
    therm_params: Optional[Dict[str, Any]] = None,
    left_pad: int = 250,
    right_pad: int = 400,
    max_candidates: int = 25,
) -> Dict[str, Any]:
    """
    Force LEFT primer to span junction, find compatible RIGHT primers.
    
    KEY FIX: Use much wider product size range to allow Primer3 to find pairs.
    """
    template = (template or "").upper().replace(" ", "")
    n_full = len(template)

    if n_full == 0:
        return {"num_pairs": 0, "primers": {"pairs": []}, "error": "Empty template"}

    junction_pos = int(junction_pos)
    if not (0 < junction_pos < n_full):
        return {"num_pairs": 0, "primers": {"pairs": []}, "error": f"junction_pos out of range"}

    args = default_primer3_args()
    if primer_params:
        args.update(primer_params)

    # KEY FIX: Relax constraints
    args["PRIMER_NUM_RETURN"] = 5
    args["PRIMER_EXPLAIN_FLAG"] = 1
    
    # Much more permissive Tm/GC
    args["PRIMER_MIN_TM"] = 55.0
    args["PRIMER_MAX_TM"] = 68.0
    args["PRIMER_MIN_GC"] = 35.0
    args["PRIMER_MAX_GC"] = 65.0

    primer_min = int(args.get("PRIMER_MIN_SIZE", 18))
    primer_max = int(args.get("PRIMER_MAX_SIZE", 25))

    # KEY FIX: VERY wide product size range
    # The user-specified range is just a preference, we need to be more flexible
    product_min_actual = max(50, int(product_min) - 50)  # Allow smaller
    product_max_actual = min(1000, int(product_max) + 300)  # Allow much larger
    
    args["PRIMER_PRODUCT_SIZE_RANGE"] = [[product_min_actual, product_max_actual]]

    args["PRIMER_PICK_LEFT_PRIMER"] = 0
    args["PRIMER_PICK_RIGHT_PRIMER"] = 1
    args["PRIMER_PICK_INTERNAL_OLIGO"] = 0

    # Local window
    left_pad = int(left_pad)
    right_pad = int(right_pad)
    win_start = _clamp(junction_pos - left_pad, 0, n_full)
    win_end = _clamp(junction_pos + right_pad, 0, n_full)

    local = template[win_start:win_end]
    j_local = junction_pos - win_start
    n = len(local)

    print(f"Junction design: template={n_full}bp, junction={junction_pos}, window={n}bp, j_local={j_local}")
    print(f"  Product range: {product_min_actual}-{product_max_actual} bp (relaxed from {product_min}-{product_max})")

    overlap_min = int(overlap_min)
    overlap_max = int(overlap_max)

    # Generate junction-spanning candidates
    candidates: List[Tuple[int, int]] = []
    for left_ov in range(overlap_min, overlap_max + 1):
        for right_ov in range(overlap_min, overlap_max + 1):
            L = left_ov + right_ov
            if L < primer_min or L > primer_max:
                continue
            start = j_local - left_ov
            end = j_local + right_ov
            if start < 0 or end > n:
                continue
            candidates.append((start, end))

    if not candidates:
        return {"num_pairs": 0, "primers": {"pairs": []}, "error": "No junction candidates in window"}

    print(f"  Generated {len(candidates)} junction-spanning candidates")
    
    # DIAGNOSTIC: Test if we can design primers on this template at all
    print(f"  DIAGNOSTIC: Testing if template can produce primers without junction constraint...")
    test_args = dict(args)
    test_args["PRIMER_PICK_LEFT_PRIMER"] = 1
    test_args["PRIMER_PICK_RIGHT_PRIMER"] = 1
    test_seq_args = {
        "SEQUENCE_ID": "diagnostic_test",
        "SEQUENCE_TEMPLATE": local,
    }
    try:
        test_out = primer3.design_primers(test_seq_args, test_args)
        test_pairs = test_out.get("PRIMER_PAIR_NUM_RETURNED", 0)
        print(f"  DIAGNOSTIC: Template can produce {test_pairs} pairs without constraint")
        if test_pairs == 0:
            print(f"  DIAGNOSTIC ERROR: Template itself is problematic!")
            print(f"    LEFT: {test_out.get('PRIMER_LEFT_EXPLAIN', '')}")
            print(f"    RIGHT: {test_out.get('PRIMER_RIGHT_EXPLAIN', '')}")
            print(f"    PAIR: {test_out.get('PRIMER_PAIR_EXPLAIN', '')}")
    except Exception as e:
        print(f"  DIAGNOSTIC: Error testing template: {e}")

    # Prefilter by Tm (very permissive)
    opt_tm = float(args.get("PRIMER_OPT_TM", 60.0))
    scored: List[Tuple[float, Tuple[int, int], Dict[str, Any]]] = []
    
    for start, end in candidates:
        left_seq = local[start:end]
        a = analyze_primer(left_seq, therm_params=therm_params)
        tm = float(a.get("tm") or 0.0)
        gc = float(a.get("gc_percent") or 0.0)
        
        # Very permissive scoring
        score = abs(tm - opt_tm)
        if gc < 35.0 or gc > 65.0:
            score += 5.0
        
        scored.append((score, (start, end), a))

    scored.sort(key=lambda x: x[0])
    scored = scored[:max_candidates]
    
    print(f"  Top candidate Tm={scored[0][2].get('tm')}°C, GC={scored[0][2].get('gc_percent')}%")

    # ---- Design RIGHT primers independently in the downstream region ----
    # We pick them once, then manually pair with each LEFT candidate.

    # RIGHT primer search region: downstream of junction, up to window end
    right_region_start = j_local  # start from junction
    right_region_len = n - right_region_start
    if right_region_len < primer_min:
        return {"num_pairs": 0, "primers": {"pairs": []}, "error": "Window too small for right primers"}

    right_args = dict(args)
    right_args["PRIMER_PICK_LEFT_PRIMER"] = 0
    right_args["PRIMER_PICK_RIGHT_PRIMER"] = 1
    right_args["PRIMER_PICK_INTERNAL_OLIGO"] = 0
    right_args["PRIMER_NUM_RETURN"] = 20  # get plenty of candidates

    right_seq_args = {
        "SEQUENCE_ID": f"right_search_{junction_pos}",
        "SEQUENCE_TEMPLATE": local,
        "SEQUENCE_INCLUDED_REGION": [right_region_start, right_region_len],
    }

    try:
        right_out = primer3.bindings.design_primers(right_seq_args, right_args)
    except AttributeError:
        right_out = primer3.design_primers(right_seq_args, right_args)

    num_right = int(right_out.get("PRIMER_RIGHT_NUM_RETURNED", 0) or 0)
    print(f"  Independent RIGHT primer search: {num_right} found")
    if num_right == 0:
        explain = right_out.get("PRIMER_RIGHT_EXPLAIN", "")
        print(f"    RIGHT explain: {explain}")
        return {"num_pairs": 0, "primers": {"pairs": []}, "error": "No RIGHT primers found in downstream region"}

    # Collect right primer candidates
    right_candidates = []
    for i in range(num_right):
        rseq = right_out.get(f"PRIMER_RIGHT_{i}_SEQUENCE")
        if not rseq:
            continue
        riv = _parse_right_interval(right_out, i)
        if not riv:
            continue
        rtm = float(right_out.get(f"PRIMER_RIGHT_{i}_TM", 0) or 0)
        rgc = float(right_out.get(f"PRIMER_RIGHT_{i}_GC_PERCENT", 0) or 0)
        right_candidates.append({
            "seq": rseq,
            "interval_local": riv,
            "tm": rtm,
            "gc": rgc,
            "idx": i,
        })

    print(f"  Parsed {len(right_candidates)} RIGHT candidates")

    # ---- Manual pairing: LEFT x RIGHT ----
    max_tm_diff = 5.0  # max Tm difference between left and right
    pairs_out: List[Dict[str, Any]] = []
    seen = set()

    for _, (start, end), left_a_pref in scored:
        left_seq = local[start:end]
        left_tm = float(left_a_pref.get("tm") or 0)
        left_interval_full = [win_start + start, win_start + end]

        for rc in right_candidates:
            right_seq = rc["seq"]
            right_tm = rc["tm"]

            # Check Tm compatibility
            if abs(left_tm - right_tm) > max_tm_diff:
                continue

            # Calculate product size: from left primer start to right primer end (in local coords)
            product_size = rc["interval_local"][1] - start
            if product_size < product_min or product_size > product_max:
                continue

            # Deduplicate
            key = (left_seq, right_seq, product_size)
            if key in seen:
                continue
            seen.add(key)

            right_interval_full = [win_start + rc["interval_local"][0], win_start + rc["interval_local"][1]]

            # Build output
            left_a = dict(left_a_pref)
            left_a["interval"] = left_interval_full
            left_a["position"] = [left_interval_full[0], left_interval_full[1] - left_interval_full[0]]

            right_a = analyze_primer(right_seq, therm_params=therm_params)
            right_a["interval"] = right_interval_full
            right_a["position"] = [right_interval_full[0], right_interval_full[1] - right_interval_full[0]]

            pair_metrics = analyze_pair(left_seq, right_seq, therm_params=therm_params)

            pairs_out.append({
                "pair_number": len(pairs_out) + 1,
                "junction_pos": int(junction_pos),
                "junction_spanning": "left",
                "left": left_a,
                "right": right_a,
                "product_size": product_size,
                "pair_metrics": pair_metrics,
            })

            if len(pairs_out) >= 10:
                break

        if len(pairs_out) >= 10:
            break

    print(f"  FINAL: {len(pairs_out)} valid pairs")

    return {"num_pairs": len(pairs_out), "primers": {"pairs": pairs_out}}