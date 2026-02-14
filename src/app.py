"""
Primerool – Cloud-based primer design tool.
Flask app backed by Ensembl REST API (no local genome/annotation files).
"""

import os
import sys

from flask import Flask, render_template, request, jsonify

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ensembl_api import (
    search_gene,
    get_transcript_details,
    build_spliced_sequence,
    build_genomic_sequence,
    get_flanking_sequence,
    cds_annotations_in_transcript_coords,
    DEFAULT_SPECIES,
)
from blast_api import run_blast, organism_to_ensembl_species
from primer_internal import design_primers_for_region
from primer_flanking import design_primers_for_flanking_regions
from primer_junction import design_junction_primer_pairs


app = Flask(__name__)


# ---------------------------------------------------------------------------
# Helper: build junction list from exon blocks
# ---------------------------------------------------------------------------

def _blocks_for_spliced_sequence(tinfo: dict, feature: str) -> list:
    """
    Return blocks in transcript 5'->3' order as [(start, end), ...].
    """
    intervals = tinfo.get(feature, [])
    if not intervals:
        return []
    blocks = sorted(intervals)
    if tinfo.get("strand") == "-":
        blocks = list(reversed(blocks))
    return blocks


def _junctions_from_blocks(blocks: list) -> list:
    """
    Given blocks in transcript order, return junction positions in spliced coords.
    """
    junctions = []
    cum = 0
    for i, (s, e) in enumerate(blocks):
        block_len = e - s + 1
        cum += block_len
        if i < len(blocks) - 1:
            junctions.append({
                "index": i,
                "pos": cum,
                "label": f"Exon {i+1}|{i+2}",
            })
    return junctions


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/blast_sequence", methods=["POST"])
def blast_sequence():
    """
    Identify a pasted sequence via NCBI BLAST.
    Accepts { sequence: "ATGCGT..." } and returns top hits with organism/gene info.
    This is a long-polling endpoint (BLAST can take 30s-2min).
    """
    data = request.json or {}
    raw_seq = (data.get("sequence") or "").strip()

    # Strip FASTA header lines if present
    lines = raw_seq.splitlines()
    # Check for Accession ID first (e.g. NR_132312.2, AL359314.14)
    # Heuristic: If meaningful chars contain digits, it's likely an ID, not a raw sequence.
    # Pattern: 1-4 letters, optional underscore, 5+ digits, optional version
    import re
    # Combine all non-header lines to check for ID
    content_lines = [l.strip() for l in lines if l.strip() and not l.strip().startswith(">")]
    full_content = " ".join(content_lines)
    
    accession_match = re.search(r"([A-Za-z]{1,4}_?[0-9]{5,}(?:\.[0-9]+)?)", full_content)
    
    if accession_match and any(c.isdigit() for c in full_content):
        # Found an ID and input has digits -> Treat as Accession ID lookup
        sequence = accession_match.group(1)
        # Verify it's not super long (an ID shouldn't be 1000 chars)
        if len(sequence) > 20: 
             # Fallback to sequence if 'ID' is suspiciously long? 
             # Actually, some IDs can be long strings? No, usually < 15 chars.
             pass 
    else:
        # Treat as raw sequence
        seq_lines = [l.strip() for l in lines if l.strip() and not l.strip().startswith(">")]
        sequence = "".join(seq_lines).upper()
        sequence = "".join(c for c in sequence if c in "ACGTNRYSWKMBDHV")

        if len(sequence) < 20:
            return jsonify({"error": "Sequence too short (need at least 20 bp)"}), 400
        if len(sequence) > 50000:
            return jsonify({"error": "Sequence too long (max 50,000 bp)"}), 400

    try:
        hits = run_blast(sequence)
    except TimeoutError:
        return jsonify({"error": "BLAST search timed out. Please try again."}), 504
    except Exception as e:
        print(f"BLAST error: {e}", flush=True)
        return jsonify({"error": f"BLAST search failed: {e}"}), 500

    if not hits:
        return jsonify({"error": "No significant matches found."}), 404

    # Enrich hits with Ensembl species code
    for hit in hits:
        hit["ensembl_species"] = organism_to_ensembl_species(hit["organism"])

    return jsonify({"hits": hits})


@app.route("/search_gene", methods=["POST"])
def search_gene_route():
    data = request.json or {}
    gene_name = (data.get("gene_name", "") or "").strip().upper()
    species = (data.get("species", "") or "").strip() or DEFAULT_SPECIES

    if not gene_name:
        return jsonify({"error": "Please provide a gene name"}), 400

    result = search_gene(gene_name, species=species)
    if not result:
        return jsonify({"error": f"Gene {gene_name} not found in Ensembl (species: {species})"}), 404

    return jsonify({
        "gene_name": result["gene_name"],
        "transcripts": [
            {
                "id": t["id"],
                "name": t["name"],
                "exon_count": t["exon_count"],
                "strand": t["strand"],
                "is_canonical": t.get("is_canonical", False),
            }
            for t in result["transcripts"]
        ],
    })


@app.route("/get_sequence", methods=["POST"])
def get_sequence():
    data = request.json or {}

    gene_name = (data.get("gene_name", "") or "").strip().upper()
    transcript_id = data.get("transcript_id")
    species = (data.get("species", "") or "").strip() or DEFAULT_SPECIES

    upstream_bp = int(data.get("upstream_bp", 0) or 0)
    downstream_bp = int(data.get("downstream_bp", 0) or 0)

    include_introns = bool(data.get("include_introns", False))
    include_utr = bool(data.get("include_utr", False))

    if not gene_name or not transcript_id:
        return jsonify({"error": "Please provide gene_name and transcript_id"}), 400

    # Get transcript details from Ensembl
    tinfo = get_transcript_details(transcript_id)
    if not tinfo:
        return jsonify({"error": f"Transcript {transcript_id} not found in Ensembl"}), 404

    exons = tinfo.get("exons", [])
    if not exons:
        return jsonify({"error": "No exon coordinates found for transcript"}), 500

    chrom = tinfo["chrom"]
    strand = tinfo["strand"]

    # Flanking sequences
    upstream_seq, downstream_seq = get_flanking_sequence(
        tinfo, upstream_bp, downstream_bp,
        use_cds_anchor=bool(tinfo.get("cds")),
        species=species,
    )

    # ALWAYS compute exon-only spliced template for junction primers
    spliced_exons_seq = build_spliced_sequence(tinfo, feature="exons", species=species) or ""
    exon_blocks = _blocks_for_spliced_sequence(tinfo, feature="exons")
    junctions = _junctions_from_blocks(exon_blocks)

    annotations = []

    if include_introns:
        # Full genomic span (with introns)
        gene_seq = build_genomic_sequence(tinfo, species=species)
        if not gene_seq:
            return jsonify({"error": "Failed to fetch genomic sequence from Ensembl"}), 500

        exon_span_start = min(s for s, e in exons)
        exon_span_end = max(e for s, e in exons)
        total_len = exon_span_end - exon_span_start + 1

        # Exon annotations (relative to genomic span)
        for exon_start, exon_end in exons:
            rel_start = exon_start - exon_span_start
            rel_end = (exon_end - exon_span_start) + 1
            if strand == "-":
                rel_start, rel_end = total_len - rel_end, total_len - rel_start
            annotations.append({"start": rel_start, "end": rel_end, "type": "exon"})

        # CDS annotations
        cds_list = tinfo.get("cds", [])
        for cds_start_i, cds_end_i in cds_list:
            if cds_end_i < exon_span_start or cds_start_i > exon_span_end:
                continue
            cds_start_i = max(cds_start_i, exon_span_start)
            cds_end_i = min(cds_end_i, exon_span_end)

            rel_start = cds_start_i - exon_span_start
            rel_end = (cds_end_i - exon_span_start) + 1
            if strand == "-":
                rel_start, rel_end = total_len - rel_end, total_len - rel_start
            annotations.append({"start": rel_start, "end": rel_end, "type": "cds"})

        annotations.sort(key=lambda a: (a["type"], a["start"]))

        feature_display = "exons" if include_utr else "cds"
        spliced_seq = build_spliced_sequence(tinfo, feature=feature_display, species=species) or ""
        if feature_display == "cds" and not spliced_seq:
            spliced_seq = ""

    else:
        # Spliced display mode
        feature_display = "exons" if include_utr else "cds"
        gene_seq = build_spliced_sequence(tinfo, feature=feature_display, species=species)

        if not gene_seq:
            if feature_display == "cds":
                return jsonify({"error": "CDS-only requested, but this transcript has no CDS (likely non-coding)."}), 400
            return jsonify({"error": "Transcript sequence extraction failed"}), 500

        spliced_seq = gene_seq

        if include_utr:
            cds_ann = cds_annotations_in_transcript_coords(tinfo)
            annotations = [{"start": s, "end": e, "type": "cds"} for (s, e) in cds_ann]

    return jsonify({
        "gene_name": gene_name,
        "transcript_id": transcript_id,
        "transcript_name": tinfo.get("transcript_name", transcript_id),
        "chrom": chrom,
        "strand": strand,

        "upstream_len": len(upstream_seq),
        "gene_len": len(gene_seq),
        "downstream_len": len(downstream_seq),

        "upstream_seq": upstream_seq,
        "gene_seq": gene_seq,
        "downstream_seq": downstream_seq,

        "spliced_seq": spliced_seq,
        "spliced_exons_seq": spliced_exons_seq,

        "junctions": junctions,
        "annotations": annotations,
        "include_introns": include_introns,
        "include_utr": include_utr,
    })


# ---------------------------------------------------------------------------
# Primer design routes (same logic, no file deps)
# ---------------------------------------------------------------------------

@app.route("/design_manual_primer", methods=["POST"])
def design_manual_primer():
    """
    Constrained single-primer design within SEQUENCE_INCLUDED_REGION.
    """
    data = request.json or {}
    which = data.get("which")
    template = data.get("template")
    include_start = int(data.get("include_start", 0))
    include_len = int(data.get("include_len", 0))

    if which not in ("left", "right"):
        return jsonify({"error": "which must be 'left' or 'right'"}), 400
    if not template or include_len <= 0:
        return jsonify({"design": None, "error": "No template/include region provided"}), 400

    from primer_manual import design_one_primer_in_region

    res = design_one_primer_in_region(
        template=template,
        include_start=include_start,
        include_len=include_len,
        which=which
    )
    if res.get("error"):
        return jsonify(res), 400
    return jsonify(res)


@app.route("/design_primers", methods=["POST"])
def design_primers():
    data = request.json or {}
    mode = data.get("mode", "internal")

    # -------------------------
    # INTERNAL: junction mode (exon-exon)
    # -------------------------
    if mode == "internal" and data.get("junction_pos") is not None:
        template = (data.get("sequence") or "").strip().upper().replace(" ", "")
        template = "".join([c for c in template if c in "ACGTN"])

        if not template:
            return jsonify({"error": "No template sequence provided"}), 400

        try:
            junction_pos = int(data.get("junction_pos"))
            ov_min = int(data.get("junction_overlap_min", 6))
            ov_max = int(data.get("junction_overlap_max", 12))
            amp_min = int(data.get("amplicon_min", 80))
            amp_max = int(data.get("amplicon_max", 220))
            left_pad = int(data.get("junction_left_pad", 250))
            right_pad = int(data.get("junction_right_pad", 400))
            max_candidates = int(data.get("junction_max_candidates", 25))
        except Exception:
            return jsonify({"error": "Invalid junction/amplicon parameters"}), 400

        if junction_pos <= 0 or junction_pos >= len(template):
            return jsonify({"error": "junction_pos out of range for provided sequence"}), 400

        ov_min = max(1, ov_min)
        ov_max = max(ov_min, ov_max)
        left_pad = max(80, min(left_pad, 800))
        right_pad = max(120, min(right_pad, 1200))
        max_candidates = max(5, min(max_candidates, 60))

        print(
            f"JUNCTION: len={len(template)} j={junction_pos} ov={ov_min}-{ov_max} "
            f"amp={amp_min}-{amp_max} window={left_pad}/{right_pad} cand={max_candidates}",
            flush=True,
        )

        try:
            out = design_junction_primer_pairs(
                template=template,
                junction_pos=junction_pos,
                overlap_min=ov_min,
                overlap_max=ov_max,
                product_min=amp_min,
                product_max=amp_max,
                left_pad=left_pad,
                right_pad=right_pad,
                max_candidates=max_candidates,
            )
        except Exception as e:
            print("JUNCTION ERROR:", repr(e), flush=True)
            return jsonify({"error": f"Junction primer design failed: {e}"}), 500

        print(f"JUNCTION: done pairs={out.get('num_pairs', 0)}", flush=True)

        if out.get("num_pairs", 0) == 0:
            return jsonify(
                {"error": "No exon-exon junction primer pairs found. Try a different junction or relax constraints."}
            ), 404

        return jsonify({"mode": "internal", **out})

    # -------------------------
    # INTERNAL: classic target region
    # -------------------------
    if mode == "internal":
        sequence = data.get("sequence")
        target_start = int(data.get("target_start"))
        target_end = int(data.get("target_end"))

        if not sequence:
            return jsonify({"error": "No sequence provided"}), 400

        if target_start < 0 or target_end > len(sequence) or target_start >= target_end:
            return jsonify({"error": "Invalid target positions"}), 400

        results = design_primers_for_region(sequence, target_start, target_end)
        num_pairs = results.get("PRIMER_PAIR_NUM_RETURNED", 0)

        if num_pairs == 0:
            return jsonify({"error": "No primers found. Try different positions."}), 404

        primer_pairs = []
        for i in range(min(5, num_pairs)):
            primer_pairs.append({
                "pair_number": i + 1,
                "left": {
                    "sequence": results.get(f"PRIMER_LEFT_{i}_SEQUENCE"),
                    "tm": round(results.get(f"PRIMER_LEFT_{i}_TM"), 1),
                    "gc": round(results.get(f"PRIMER_LEFT_{i}_GC_PERCENT"), 1),
                    "position": results.get(f"PRIMER_LEFT_{i}"),
                },
                "right": {
                    "sequence": results.get(f"PRIMER_RIGHT_{i}_SEQUENCE"),
                    "tm": round(results.get(f"PRIMER_RIGHT_{i}_TM"), 1),
                    "gc": round(results.get(f"PRIMER_RIGHT_{i}_GC_PERCENT"), 1),
                    "position": results.get(f"PRIMER_RIGHT_{i}"),
                },
                "product_size": results.get(f"PRIMER_PAIR_{i}_PRODUCT_SIZE"),
            })

        return jsonify({"mode": "internal", "num_pairs": num_pairs, "primers": primer_pairs})

    # -------------------------
    # FLANKING (WGA)
    # -------------------------
    upstream_seq = data.get("upstream_seq")
    downstream_seq = data.get("downstream_seq")

    if not upstream_seq or not downstream_seq:
        return jsonify({"error": "No flanking sequences provided"}), 400

    results = design_primers_for_flanking_regions(upstream_seq, downstream_seq)

    if results["forward"]["num_returned"] == 0 or results["reverse"]["num_returned"] == 0:
        details = []
        if results["forward"]["num_returned"] == 0:
            explain = results["forward"].get("explain", "")
            details.append(f"Forward: {explain}" if explain else "Forward: no candidates")
        if results["reverse"]["num_returned"] == 0:
            explain = results["reverse"].get("explain", "")
            details.append(f"Reverse: {explain}" if explain else "Reverse: no candidates")
        detail_str = " | ".join(details)
        return jsonify({"error": f"No primers found. {detail_str}"}), 404

    return jsonify({
        "mode": "flanking",
        "primers": {
            "forward": results["forward"],
            "reverse": results["reverse"],
            "pair_metrics": results.get("pair_metrics"),
        },
    })


@app.route("/analyze_manual_primers", methods=["POST"])
def analyze_manual_primers():
    from primer_utils import analyze_primer, analyze_pair

    data = request.json or {}
    fwd = (data.get("forward") or "").strip().upper()
    rev = (data.get("reverse") or "").strip().upper()

    out: dict = {}
    if fwd:
        out["forward"] = analyze_primer(fwd)
    if rev:
        out["reverse"] = analyze_primer(rev)
    if fwd and rev:
        out["pair"] = analyze_pair(fwd, rev)

    return jsonify(out)


@app.route("/design_from_sequence", methods=["POST"])
def design_from_sequence():
    """
    Design primers from two user-provided sequence regions.
    """
    data = request.json or {}

    def clean_seq(s):
        s = (s or "").strip().upper().replace(" ", "").replace("\n", "")
        return "".join(c for c in s if c in "ACGTN")

    fwd_region = clean_seq(data.get("forward_region", ""))
    rev_region = clean_seq(data.get("reverse_region", ""))

    if len(fwd_region) < 18:
        return jsonify({"error": "Forward region too short (need at least 18 bp)"}), 400
    if len(rev_region) < 18:
        return jsonify({"error": "Reverse region too short (need at least 18 bp)"}), 400

    from primer_utils import default_primer3_args, analyze_primer, analyze_pair
    import primer3 as p3

    base_args = default_primer3_args()
    base_args["PRIMER_NUM_RETURN"] = 5
    base_args["PRIMER_PICK_INTERNAL_OLIGO"] = 0

    # Forward (LEFT) primers
    fwd_args = dict(base_args)
    fwd_args["PRIMER_PICK_LEFT_PRIMER"] = 1
    fwd_args["PRIMER_PICK_RIGHT_PRIMER"] = 0

    fwd_result = p3.design_primers(
        {"SEQUENCE_ID": "fwd_region", "SEQUENCE_TEMPLATE": fwd_region}, fwd_args
    )
    num_fwd = int(fwd_result.get("PRIMER_LEFT_NUM_RETURNED", 0) or 0)

    forward_primers = []
    for i in range(num_fwd):
        seq = fwd_result.get(f"PRIMER_LEFT_{i}_SEQUENCE", "")
        if seq:
            forward_primers.append(analyze_primer(seq))

    # Reverse (RIGHT) primers
    rev_args = dict(base_args)
    rev_args["PRIMER_PICK_LEFT_PRIMER"] = 0
    rev_args["PRIMER_PICK_RIGHT_PRIMER"] = 1

    rev_result = p3.design_primers(
        {"SEQUENCE_ID": "rev_region", "SEQUENCE_TEMPLATE": rev_region}, rev_args
    )
    num_rev = int(rev_result.get("PRIMER_RIGHT_NUM_RETURNED", 0) or 0)

    reverse_primers = []
    for i in range(num_rev):
        seq = rev_result.get(f"PRIMER_RIGHT_{i}_SEQUENCE", "")
        if seq:
            reverse_primers.append(analyze_primer(seq))

    # Manual pairing
    best_pairs = []
    if forward_primers and reverse_primers:
        combos = []
        for fp in forward_primers:
            for rp in reverse_primers:
                pair_info = analyze_pair(fp["sequence"], rp["sequence"])
                tm_diff = abs(float(fp.get("tm") or 0) - float(rp.get("tm") or 0))
                het = pair_info.get("heterodimer", {})
                het_dg = float(het.get("dg") or 0)
                score = tm_diff + max(0, het_dg + 10) * 0.1
                combos.append({
                    "forward_seq": fp["sequence"],
                    "forward_tm": fp.get("tm"),
                    "reverse_seq": rp["sequence"],
                    "reverse_tm": rp.get("tm"),
                    "tm_diff": round(tm_diff, 1),
                    "heterodimer": het,
                    "score": score,
                })
        combos.sort(key=lambda x: x["score"])
        best_pairs = combos[:5]

    errors = []
    if not forward_primers:
        explain = fwd_result.get("PRIMER_LEFT_EXPLAIN", "")
        errors.append(f"No forward primers found. {explain}")
    if not reverse_primers:
        explain = rev_result.get("PRIMER_RIGHT_EXPLAIN", "")
        errors.append(f"No reverse primers found. {explain}")

    if errors:
        return jsonify({"error": " | ".join(errors)}), 404

    return jsonify({
        "forward_primers": forward_primers,
        "reverse_primers": reverse_primers,
        "best_pairs": best_pairs,
    })


if __name__ == "__main__":
    app.run(debug=True, port=5050)
