# primer_internal.py
from typing import Dict, Any, Optional
import primer3

from primer_utils import default_primer3_args


def design_primers_for_region(
    sequence: str,
    target_start: int,
    target_end: int,
    primer_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Classic internal primer pairs around a target region inside `sequence`.
    target_start/target_end are 0-based indices into `sequence` (end exclusive).
    """
    sequence = (sequence or "").upper().replace(" ", "")

    args = default_primer3_args()
    args.update({
        "PRIMER_PRODUCT_SIZE_RANGE": [[100, 1000]],
        "PRIMER_NUM_RETURN": 5,
        "PRIMER_PICK_INTERNAL_OLIGO": 0,
    })
    if primer_params:
        args.update(primer_params)

    seq_args = {
        "SEQUENCE_ID": "internal_target",
        "SEQUENCE_TEMPLATE": sequence,
        "SEQUENCE_TARGET": [int(target_start), int(target_end - target_start)],
    }

    return primer3.design_primers(seq_args, args)