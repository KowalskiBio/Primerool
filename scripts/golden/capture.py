#!/usr/bin/env python3
"""Golden-fixture capture for the Primerool Rust rewrite.

Hits the *existing* Flask app (must already be running, e.g. via
`backend/dev_server.py`) across a fixed matrix of real inputs and serializes
every (request, response) pair to scripts/golden/fixtures/<name>.json.

These fixtures are the spec for Phases 2-6 of the rewrite plan: the Rust
axum server must reproduce them exactly (mod any explicitly-documented
drift, e.g. wall-clock-dependent BLAST job timing).

Run with the Flask dev server already listening on 127.0.0.1:5050:

    source .venv/bin/activate && python backend/dev_server.py &
    python scripts/golden/capture.py

Live upstream (Ensembl/NCBI) calls mean this script's exact output can
drift over time as those databases are updated, and can fail outright if
an upstream is degraded (this happened during initial capture: Ensembl's
/lookup/symbol endpoint was returning 500 for most gene symbols except
BRCA1 - that failure was itself captured as a fixture, since it documents
real error-propagation behavior the Rust port must also replicate).
"""

import json
import sys
from pathlib import Path

import requests

BASE = "http://127.0.0.1:5050"
FIXTURES_DIR = Path(__file__).parent / "fixtures"
FIXTURES_DIR.mkdir(parents=True, exist_ok=True)


def call(method: str, path: str, body: dict | None = None, timeout: int = 60) -> tuple[int, dict]:
    url = f"{BASE}{path}"
    resp = requests.request(method, url, json=body, timeout=timeout)
    try:
        parsed = resp.json()
    except ValueError:
        parsed = {"_raw_text": resp.text}
    return resp.status_code, parsed


def save_fixture(name: str, method: str, path: str, body: dict | None, status: int, response: dict) -> None:
    fixture = {
        "name": name,
        "request": {"method": method, "path": path, "body": body},
        "response": {"status": status, "body": response},
    }
    out = FIXTURES_DIR / f"{name}.json"
    out.write_text(json.dumps(fixture, indent=2, sort_keys=True))
    print(f"  -> {out.relative_to(FIXTURES_DIR.parent.parent)} (status {status})")


def capture(name: str, method: str, path: str, body: dict | None = None, timeout: int = 60) -> dict:
    print(f"[{name}] {method} {path}")
    status, response = call(method, path, body, timeout=timeout)
    save_fixture(name, method, path, body, status, response)
    return response


def main() -> None:
    # -- 1. search_gene: one case per provider/strand/edge-case combination --
    brca1 = capture(
        "search_gene_ensembl_brca1",
        "POST", "/search_gene",
        {"gene_name": "BRCA1", "species": "homo_sapiens", "api_source": "ensembl"},
    )
    tp53 = capture(
        "search_gene_ncbi_tp53",
        "POST", "/search_gene",
        {"gene_name": "TP53", "species": "homo_sapiens", "api_source": "ncbi"},
    )
    malat1 = capture(
        "search_gene_ncbi_malat1_noncoding",
        "POST", "/search_gene",
        {"gene_name": "MALAT1", "species": "homo_sapiens", "api_source": "ncbi"},
    )
    dnaa = capture(
        "search_gene_ncbi_dnaa_prokaryote",
        "POST", "/search_gene",
        {"gene_name": "dnaA", "species": "escherichia_coli_str_k_12_substr_mg1655", "api_source": "ncbi"},
    )
    # Documents real upstream-error propagation: at capture time, Ensembl's
    # /lookup/symbol endpoint was returning 500 for most symbols (see
    # module docstring). The Rust port's error handling must be verified
    # against whatever this fixture actually recorded, not an idealized
    # "gene not found" 404.
    capture(
        "search_gene_ensembl_upstream_error",
        "POST", "/search_gene",
        {"gene_name": "TP53", "species": "homo_sapiens", "api_source": "ensembl"},
    )
    capture(
        "search_gene_ensembl_not_found",
        "POST", "/search_gene",
        {"gene_name": "totallynotarealgenexyz123", "species": "homo_sapiens", "api_source": "ensembl"},
    )

    def canonical_transcript(search_result: dict) -> str | None:
        for t in search_result.get("transcripts", []):
            if t.get("is_canonical"):
                return t["id"]
        transcripts = search_result.get("transcripts", [])
        return transcripts[0]["id"] if transcripts else None

    brca1_tid = canonical_transcript(brca1)
    tp53_tid = canonical_transcript(tp53)
    malat1_tid = canonical_transcript(malat1)
    dnaa_tid = canonical_transcript(dnaa)

    # -- 2. get_sequence: strand/coordinate edge cases --
    brca1_default = capture(
        "get_sequence_brca1_default",
        "POST", "/get_sequence",
        {
            "gene_name": "BRCA1", "transcript_id": brca1_tid, "species": "homo_sapiens",
            "api_source": "ensembl", "upstream_bp": 200, "downstream_bp": 200,
            "include_introns": False, "include_utr": True,
        },
    ) if brca1_tid else {}

    capture(
        "get_sequence_brca1_with_introns",
        "POST", "/get_sequence",
        {
            "gene_name": "BRCA1", "transcript_id": brca1_tid, "species": "homo_sapiens",
            "api_source": "ensembl", "upstream_bp": 200, "downstream_bp": 200,
            "include_introns": True, "include_utr": True,
        },
    ) if brca1_tid else None

    capture(
        "get_sequence_brca1_cds_only",
        "POST", "/get_sequence",
        {
            "gene_name": "BRCA1", "transcript_id": brca1_tid, "species": "homo_sapiens",
            "api_source": "ensembl", "upstream_bp": 200, "downstream_bp": 200,
            "include_introns": False, "include_utr": False,
        },
    ) if brca1_tid else None

    tp53_default = capture(
        "get_sequence_tp53_ncbi_minus_strand",
        "POST", "/get_sequence",
        {
            "gene_name": "TP53", "transcript_id": tp53_tid, "species": "homo_sapiens",
            "api_source": "ncbi", "upstream_bp": 200, "downstream_bp": 200,
            "include_introns": False, "include_utr": True,
        },
    ) if tp53_tid else {}

    capture(
        "get_sequence_malat1_noncoding_cds_fallback",
        "POST", "/get_sequence",
        {
            "gene_name": "MALAT1", "transcript_id": malat1_tid, "species": "homo_sapiens",
            "api_source": "ncbi", "upstream_bp": 200, "downstream_bp": 200,
            "include_introns": False, "include_utr": False,
        },
    ) if malat1_tid else None

    capture(
        "get_sequence_dnaa_prokaryote",
        "POST", "/get_sequence",
        {
            "gene_name": "dnaA", "transcript_id": dnaa_tid, "species": "escherichia_coli_str_k_12_substr_mg1655",
            "api_source": "ncbi", "upstream_bp": 100, "downstream_bp": 100,
            "include_introns": False, "include_utr": True,
        },
    ) if dnaa_tid else None

    # -- 3-5. design_primers / design_from_sequence / design_probe --
    # Driven off whichever gene's get_sequence actually succeeded (upstream
    # availability is real-world flaky - see module docstring); prefer
    # tp53_default (NCBI, confirmed reliable at capture time) and fall back
    # to brca1_default (Ensembl) if it's the one that came through instead.
    pipeline_gene, pipeline_label = (tp53_default, "tp53") if tp53_default.get("gene_seq") else (brca1_default, "brca1")

    if pipeline_gene.get("gene_seq"):
        upstream_seq = pipeline_gene.get("upstream_seq", "")
        downstream_seq = pipeline_gene.get("downstream_seq", "")
        if upstream_seq and downstream_seq:
            capture(
                f"design_primers_flanking_{pipeline_label}",
                "POST", "/design_primers",
                {"mode": "flanking", "upstream_seq": upstream_seq, "downstream_seq": downstream_seq},
            )

        spliced_exons_seq = pipeline_gene.get("spliced_exons_seq", "")
        junctions = pipeline_gene.get("junctions", [])
        if spliced_exons_seq and junctions:
            junction_pos = junctions[0]["pos"]
            capture(
                f"design_primers_junction_{pipeline_label}",
                "POST", "/design_primers",
                {
                    "mode": "internal", "sequence": spliced_exons_seq, "junction_pos": junction_pos,
                    "overlap_min": 6, "overlap_max": 12, "amplicon_min": 80, "amplicon_max": 220,
                },
            )

        gene_seq = pipeline_gene["gene_seq"]
        if len(gene_seq) > 400:
            capture(
                f"design_primers_internal_classic_{pipeline_label}",
                "POST", "/design_primers",
                {"mode": "internal", "sequence": gene_seq, "target_start": 100, "target_end": 300},
            )

        # -- 4. design_from_sequence: unified single-call path + independent fallback --
        if len(gene_seq) > 500:
            fwd_region = gene_seq[50:90]
            rev_region = gene_seq[300:340]
            fwd_pos = gene_seq.find(fwd_region)
            rev_pos = gene_seq.find(rev_region)
            capture(
                f"design_from_sequence_unified_with_template_{pipeline_label}",
                "POST", "/design_from_sequence",
                {
                    "forward_region": fwd_region, "reverse_region": rev_region,
                    "template_seq": gene_seq, "fwd_pos": fwd_pos, "rev_pos": rev_pos,
                    "amplicon_target": 250, "amplicon_deviation": 50,
                },
            )
            capture(
                f"design_from_sequence_independent_fallback_no_template_{pipeline_label}",
                "POST", "/design_from_sequence",
                {"forward_region": fwd_region, "reverse_region": rev_region},
            )

            # -- 5. design_probe: TaqMan --
            probe_region = gene_seq[150:250]
            capture(
                f"design_probe_taqman_{pipeline_label}",
                "POST", "/design_probe",
                {"probe_region": probe_region},
            )

    # -- 6. blast_sequence: long-running (up to ~180s), captured last --
    if pipeline_gene.get("gene_seq"):
        blast_fragment = pipeline_gene["gene_seq"][:300]
        print("[blast_sequence] submitting - this can take up to ~180s ...")
        capture(
            f"blast_sequence_{pipeline_label}_fragment",
            "POST", "/blast_sequence",
            {"sequence": blast_fragment},
            timeout=220,
        )

    fixture_count = len(list(FIXTURES_DIR.glob("*.json")))
    print(f"\nCaptured {fixture_count} fixtures in {FIXTURES_DIR}")


if __name__ == "__main__":
    main()
