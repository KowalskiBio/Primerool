"""
ensembl_api.py — Cloud-based gene/transcript/sequence fetching via Ensembl REST API.
Replaces local genome (FASTA) and annotation (GTF) file dependencies.
"""

import time
import requests
from functools import lru_cache
from typing import Dict, List, Optional, Any, Tuple

ENSEMBL_REST = "https://rest.ensembl.org"
DEFAULT_SPECIES = "homo_sapiens"

# Ensembl public API: max 15 requests/second
_last_request_time = 0.0
_MIN_INTERVAL = 0.07  # ~14 req/s to stay safe


def _get(endpoint: str, params: Optional[dict] = None) -> dict:
    """Make a GET request to the Ensembl REST API with rate limiting."""
    global _last_request_time
    now = time.time()
    wait = _MIN_INTERVAL - (now - _last_request_time)
    if wait > 0:
        time.sleep(wait)

    url = f"{ENSEMBL_REST}{endpoint}"
    headers = {"Content-Type": "application/json"}
    resp = requests.get(url, headers=headers, params=params, timeout=30)
    _last_request_time = time.time()

    if resp.status_code == 429:
        # Rate limited — wait and retry once
        retry_after = float(resp.headers.get("Retry-After", 1))
        print(f"  Ensembl rate-limited, waiting {retry_after}s...")
        time.sleep(retry_after)
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        _last_request_time = time.time()

    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Gene search
# ---------------------------------------------------------------------------

@lru_cache(maxsize=256)
def search_gene(gene_name: str, species: str = DEFAULT_SPECIES) -> Optional[Dict[str, Any]]:
    """
    Look up a gene by symbol. Returns gene info with transcript list.
    Uses: GET /lookup/symbol/{species}/{symbol}?expand=1
    """
    gene_name = gene_name.strip().upper()
    try:
        data = _get(f"/lookup/symbol/{species}/{gene_name}", {"expand": "1"})
    except requests.HTTPError as e:
        if e.response is not None and e.response.status_code == 404:
            return None
        raise

    if data.get("object_type") != "Gene":
        return None

    transcripts = []
    for t in data.get("Transcript", []):
        transcripts.append({
            "id": t["id"],
            "name": t.get("display_name") or t["id"],
            "biotype": t.get("biotype", ""),
            "strand": "+" if t.get("strand", 1) == 1 else "-",
            "exon_count": len(t.get("Exon", [])),
            "is_canonical": bool(t.get("is_canonical", False)),
        })

    return {
        "gene_name": gene_name,
        "gene_id": data["id"],
        "chrom": str(data.get("seq_region_name", "")),
        "strand": "+" if data.get("strand", 1) == 1 else "-",
        "start": data.get("start"),
        "end": data.get("end"),
        "transcripts": transcripts,
    }


# ---------------------------------------------------------------------------
# Transcript details (exons, CDS, UTRs)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=256)
def get_transcript_details(transcript_id: str) -> Optional[Dict[str, Any]]:
    """
    Get full transcript structure: exons, CDS, UTRs.
    Uses: GET /lookup/id/{id}?expand=1
    """
    try:
        data = _get(f"/lookup/id/{transcript_id}", {"expand": "1"})
    except requests.HTTPError as e:
        if e.response is not None and e.response.status_code == 404:
            return None
        raise

    chrom = str(data.get("seq_region_name", ""))
    strand = "+" if data.get("strand", 1) == 1 else "-"

    # Parse exons
    exons = []
    for ex in data.get("Exon", []):
        exons.append((ex["start"], ex["end"]))
    exons.sort()

    # Parse UTRs and CDS from the Translation
    cds = []
    utr5 = []
    utr3 = []

    translation = data.get("Translation")
    if translation:
        # CDS boundaries from Translation start/end
        cds_genomic_start = translation.get("start")
        cds_genomic_end = translation.get("end")

        if cds_genomic_start and cds_genomic_end:
            # CDS = portions of exons that overlap [cds_genomic_start, cds_genomic_end]
            for ex_start, ex_end in exons:
                ov_start = max(ex_start, cds_genomic_start)
                ov_end = min(ex_end, cds_genomic_end)
                if ov_start <= ov_end:
                    cds.append((ov_start, ov_end))

                # UTR regions (parts of exons outside CDS)
                if strand == "+":
                    # 5'UTR: exon portion before CDS start
                    if ex_start < cds_genomic_start and ex_end >= ex_start:
                        utr5_end = min(ex_end, cds_genomic_start - 1)
                        if ex_start <= utr5_end:
                            utr5.append((ex_start, utr5_end))
                    # 3'UTR: exon portion after CDS end
                    if ex_end > cds_genomic_end and ex_start <= ex_end:
                        utr3_start = max(ex_start, cds_genomic_end + 1)
                        if utr3_start <= ex_end:
                            utr3.append((utr3_start, ex_end))
                else:
                    # Minus strand: 5'UTR is at higher genomic coords
                    if ex_end > cds_genomic_end:
                        utr5_start = max(ex_start, cds_genomic_end + 1)
                        if utr5_start <= ex_end:
                            utr5.append((utr5_start, ex_end))
                    if ex_start < cds_genomic_start:
                        utr3_end = min(ex_end, cds_genomic_start - 1)
                        if ex_start <= utr3_end:
                            utr3.append((ex_start, utr3_end))

    return {
        "transcript_id": transcript_id,
        "transcript_name": data.get("display_name") or transcript_id,
        "chrom": chrom,
        "strand": strand,
        "exons": exons,
        "cds": sorted(cds),
        "utr5": sorted(utr5),
        "utr3": sorted(utr3),
        "utr": sorted(utr5 + utr3),
    }


# ---------------------------------------------------------------------------
# Sequence fetching
# ---------------------------------------------------------------------------

def get_sequence_by_id(ensembl_id: str, seq_type: str = "genomic") -> Optional[str]:
    """
    Fetch sequence for an Ensembl ID.
    seq_type: 'genomic', 'cdna', 'cds'
    Uses: GET /sequence/id/{id}?type={type}
    """
    try:
        data = _get(f"/sequence/id/{ensembl_id}", {"type": seq_type})
    except requests.HTTPError:
        return None

    return data.get("seq")


def get_region_sequence(chrom: str, start: int, end: int, strand: int = 1,
                        species: str = DEFAULT_SPECIES) -> Optional[str]:
    """
    Fetch a genomic region sequence.
    Uses: GET /sequence/region/{species}/{region}
    strand: 1 or -1
    """
    if end < start:
        return ""
    region = f"{chrom}:{start}..{end}:{strand}"
    try:
        data = _get(f"/sequence/region/{species}/{region}")
    except requests.HTTPError:
        return None

    return data.get("seq")


# ---------------------------------------------------------------------------
# High-level helpers (used by app.py)
# ---------------------------------------------------------------------------

def build_spliced_sequence(tinfo: dict, feature: str = "exons",
                           species: str = DEFAULT_SPECIES) -> Optional[str]:
    """
    Build a spliced (concatenated) sequence from exon or CDS intervals.
    Fetches each interval from Ensembl and concatenates in transcript order.
    feature: 'exons' or 'cds'
    """
    intervals = tinfo.get(feature, [])
    if not intervals:
        return None

    chrom = tinfo["chrom"]
    strand = tinfo["strand"]
    intervals_sorted = sorted(intervals)

    parts = []
    for start, end in intervals_sorted:
        seq = get_region_sequence(chrom, start, end, strand=1, species=species)
        if seq is None:
            return None
        parts.append(seq)

    full = "".join(parts)

    if strand == "-":
        # Reverse complement
        comp = str.maketrans("ACGTacgt", "TGCAtgca")
        full = full.translate(comp)[::-1]

    return full.upper()


def build_genomic_sequence(tinfo: dict, species: str = DEFAULT_SPECIES) -> Optional[str]:
    """
    Fetch the full genomic span (including introns) for a transcript.
    """
    exons = tinfo.get("exons", [])
    if not exons:
        return None

    chrom = tinfo["chrom"]
    strand = tinfo["strand"]
    gene_start = min(s for s, e in exons)
    gene_end = max(e for s, e in exons)

    seq = get_region_sequence(chrom, gene_start, gene_end, strand=1, species=species)
    if seq is None:
        return None

    if strand == "-":
        comp = str.maketrans("ACGTacgt", "TGCAtgca")
        seq = seq.translate(comp)[::-1]

    return seq.upper()


def get_flanking_sequence(tinfo: dict, upstream_bp: int, downstream_bp: int,
                          use_cds_anchor: bool = True,
                          species: str = DEFAULT_SPECIES) -> Tuple[str, str]:
    """
    Fetch upstream and downstream flanking sequences relative to transcript direction.
    Returns (upstream_seq, downstream_seq).
    """
    exons = tinfo.get("exons", [])
    cds = tinfo.get("cds", [])
    strand = tinfo["strand"]
    chrom = tinfo["chrom"]

    if not exons:
        return "", ""

    # Determine anchor points
    if use_cds_anchor and cds:
        anchor_start = min(s for s, e in cds)
        anchor_end = max(e for s, e in cds)
    else:
        anchor_start = min(s for s, e in exons)
        anchor_end = max(e for s, e in exons)

    if strand == "+":
        upstream_seq = ""
        if upstream_bp > 0:
            us = max(1, anchor_start - upstream_bp)
            ue = anchor_start - 1
            upstream_seq = get_region_sequence(chrom, us, ue, strand=1, species=species) or ""

        downstream_seq = ""
        if downstream_bp > 0:
            ds = anchor_end + 1
            de = anchor_end + downstream_bp
            downstream_seq = get_region_sequence(chrom, ds, de, strand=1, species=species) or ""
    else:
        # Minus strand: upstream is at higher coords, downstream at lower
        upstream_seq = ""
        if upstream_bp > 0:
            us = anchor_end + 1
            ue = anchor_end + upstream_bp
            raw = get_region_sequence(chrom, us, ue, strand=1, species=species) or ""
            comp = str.maketrans("ACGTacgt", "TGCAtgca")
            upstream_seq = raw.translate(comp)[::-1].upper()

        downstream_seq = ""
        if downstream_bp > 0:
            ds = max(1, anchor_start - downstream_bp)
            de = anchor_start - 1
            raw = get_region_sequence(chrom, ds, de, strand=1, species=species) or ""
            comp = str.maketrans("ACGTacgt", "TGCAtgca")
            downstream_seq = raw.translate(comp)[::-1].upper()

    return upstream_seq, downstream_seq


def cds_annotations_in_transcript_coords(tinfo: dict) -> List[Tuple[int, int]]:
    """
    Map genomic CDS intervals -> transcript coords (0-based, end-exclusive)
    within exon-concatenated transcript.
    """
    exons = tinfo.get("exons", [])
    cds = tinfo.get("cds", [])
    strand = tinfo.get("strand", "+")

    if not exons or not cds:
        return []

    exons_sorted = sorted(exons)
    cds_sorted = sorted(cds)

    ann: List[Tuple[int, int]] = []
    exon_offset = 0
    j = 0

    for exon_start, exon_end in exons_sorted:
        exon_len = exon_end - exon_start + 1

        while j < len(cds_sorted) and cds_sorted[j][1] < exon_start:
            j += 1

        k = j
        while k < len(cds_sorted) and cds_sorted[k][0] <= exon_end:
            cds_start, cds_end = cds_sorted[k]
            ov_start = max(exon_start, cds_start)
            ov_end = min(exon_end, cds_end)
            if ov_start <= ov_end:
                rel_start = exon_offset + (ov_start - exon_start)
                rel_end = exon_offset + (ov_end - exon_start) + 1
                ann.append((rel_start, rel_end))
            k += 1

        exon_offset += exon_len

    if strand == "-":
        total_len = sum((e[1] - e[0] + 1) for e in exons_sorted)
        ann = [(total_len - end, total_len - start) for (start, end) in ann]
        ann.sort()

    return ann
