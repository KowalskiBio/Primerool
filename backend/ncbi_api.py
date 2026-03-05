"""
ncbi_api.py — Gene/transcript/sequence fetching via NCBI E-utilities.
Alternative to ensembl_api.py when Ensembl REST API is down/slow.
Same interface and return formats for drop-in compatibility.
"""

import re
import time
import requests
from functools import lru_cache
from typing import Dict, List, Optional, Any, Tuple

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
DEFAULT_SPECIES = "homo_sapiens"

# NCBI rate limits: 3 req/s without API key
_last_request_time = 0.0
_MIN_INTERVAL = 0.34

# Species name mapping
_SPECIES_MAP = {
    # Animals / Vertebrates
    "homo_sapiens": "Homo sapiens",
    "mus_musculus": "Mus musculus",
    "rattus_norvegicus": "Rattus norvegicus",
    "danio_rerio": "Danio rerio",
    "gallus_gallus": "Gallus gallus",
    "drosophila_melanogaster": "Drosophila melanogaster",
    "caenorhabditis_elegans": "Caenorhabditis elegans",
    "xenopus_tropicalis": "Xenopus tropicalis",
    "sus_scrofa": "Sus scrofa",
    "bos_taurus": "Bos taurus",
    "ovis_aries": "Ovis aries",
    "canis_lupus_familiaris": "Canis lupus familiaris",
    "felis_catus": "Felis catus",
    "macaca_mulatta": "Macaca mulatta",
    "pan_troglodytes": "Pan troglodytes",
    "oryctolagus_cuniculus": "Oryctolagus cuniculus",
    # Fungi
    "saccharomyces_cerevisiae": "Saccharomyces cerevisiae",
    "schizosaccharomyces_pombe": "Schizosaccharomyces pombe",
    "aspergillus_nidulans": "Aspergillus nidulans",
    "neurospora_crassa": "Neurospora crassa",
    "candida_albicans": "Candida albicans",
    # Plants
    "arabidopsis_thaliana": "Arabidopsis thaliana",
    "oryza_sativa": "Oryza sativa",
    "zea_mays": "Zea mays",
    "triticum_aestivum": "Triticum aestivum",
    "solanum_lycopersicum": "Solanum lycopersicum",
    "glycine_max": "Glycine max",
    "vitis_vinifera": "Vitis vinifera",
    "solanum_tuberosum": "Solanum tuberosum",
    "hordeum_vulgare": "Hordeum vulgare",
    "nicotiana_tabacum": "Nicotiana tabacum",
    # Bacteria (Ensembl Bacteria requires GCA accession suffix)
    "escherichia_coli_str_k_12_substr_mg1655_gca_000005845": "Escherichia coli",
    "bacillus_subtilis_subsp_subtilis_str_168_gca_000009045": "Bacillus subtilis",
    "staphylococcus_aureus_subsp_aureus_nctc_8325_gca_000013425": "Staphylococcus aureus",
    "pseudomonas_aeruginosa_pao1_gca_000006765": "Pseudomonas aeruginosa",
    "mycobacterium_tuberculosis_h37ra_gca_000016145": "Mycobacterium tuberculosis",
    "salmonella_enterica_subsp_enterica_serovar_typhimurium_str_lt2_gca_000006945": "Salmonella enterica",
    "streptococcus_pneumoniae_tigr4_gca_000006885": "Streptococcus pneumoniae",
    # Protists
    "plasmodium_falciparum": "Plasmodium falciparum",
    "trypanosoma_brucei": "Trypanosoma brucei",
    "leishmania_major": "Leishmania major",
    "toxoplasma_gondii_me49": "Toxoplasma gondii",
    "dictyostelium_discoideum": "Dictyostelium discoideum",
}

# Cache for transcript details parsed from gene_table
_transcript_cache: Dict[str, dict] = {}


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------

def _get(url: str, params: dict, timeout: int = 30) -> requests.Response:
    """Rate-limited GET request to NCBI."""
    global _last_request_time
    now = time.time()
    wait = _MIN_INTERVAL - (now - _last_request_time)
    if wait > 0:
        time.sleep(wait)

    resp = requests.get(url, params=params, timeout=timeout)
    _last_request_time = time.time()
    resp.raise_for_status()
    return resp


def _fetch_fasta_seq(params: dict, timeout: int = 60) -> Optional[str]:
    """Fetch a FASTA sequence from E-utilities efetch and return raw sequence."""
    try:
        resp = _get(f"{EUTILS}/efetch.fcgi", params, timeout=timeout)
    except requests.HTTPError:
        return None

    lines = resp.text.strip().split("\n")
    seq_lines = [l.strip() for l in lines if l.strip() and not l.startswith(">")]
    seq = "".join(seq_lines).upper()
    return seq if seq else None


# ---------------------------------------------------------------------------
# Gene table parser
# ---------------------------------------------------------------------------

def _parse_gene_table(text: str, chrom: str, chr_accession: str,
                      strand: str, gene_start: int, gene_end: int) -> Dict[str, dict]:
    """
    Parse NCBI gene_table format to extract per-transcript exon/CDS coordinates.
    Returns dict of transcript_id -> tinfo dict.
    """
    lines = text.strip().split("\n")
    transcripts: Dict[str, dict] = {}
    current_tid = None
    in_exon_table = False

    for line in lines:
        line = line.rstrip()

        # Transcript header: "mRNA transcript variant R NM_020984.4, 15 exons, ..."
        # Also handles: "ncRNA ... NR_XXXX.X, N exons, ..."
        mrna_match = re.match(
            r'(?:mRNA|ncRNA|misc_RNA)\s+(.*?)\s+((NM_|NR_|XM_|XR_)\S+),\s*(\d+)\s+exons?',
            line
        )
        if mrna_match:
            variant_name = mrna_match.group(1).strip()
            tid = mrna_match.group(2)
            current_tid = tid
            transcripts[tid] = {
                "transcript_id": tid,
                "transcript_name": variant_name or tid,
                "chrom": chrom,
                "chr_accession": chr_accession,
                "strand": strand,
                "exons": [],
                "cds": [],
            }
            in_exon_table = False
            continue

        # Dashes separator → exon data rows follow
        if re.match(r'^-{20,}', line):
            in_exon_table = True
            continue

        # New section headers reset exon table mode
        if line.startswith("Exon table") or line.startswith("Genomic Interval"):
            continue
        if line.startswith("protein "):
            continue

        # A new "Reference" or "mRNA" line ends the current exon table
        if line.startswith("Reference") or re.match(r'^(?:mRNA|ncRNA)', line):
            in_exon_table = False
            # Re-check for mRNA match (handled above on next iteration)

        # Parse exon data rows
        if in_exon_table and current_tid and line.strip():
            # Find all NUMBER-NUMBER intervals in the line
            intervals = re.findall(r'(\d+)-(\d+)', line)
            if not intervals:
                continue

            # First interval is always genomic exon coords
            exon_s, exon_e = int(intervals[0][0]), int(intervals[0][1])
            # Normalise so start <= end (NCBI reports minus-strand as high-low)
            if exon_s > exon_e:
                exon_s, exon_e = exon_e, exon_s
            transcripts[current_tid]["exons"].append((exon_s, exon_e))

            # Second interval: genomic coding coords (if it's within the gene range)
            if len(intervals) >= 2:
                cds_s, cds_e = int(intervals[1][0]), int(intervals[1][1])
                if cds_s > cds_e:
                    cds_s, cds_e = cds_e, cds_s
                # Genomic CDS coords should be within gene boundaries
                if cds_s >= gene_start - 1 and cds_e <= gene_end + 1:
                    transcripts[current_tid]["cds"].append((cds_s, cds_e))

        # Blank line ends exon table
        if not line.strip():
            in_exon_table = False

    # Post-process: sort exons/cds, compute UTRs
    for tid, tinfo in transcripts.items():
        tinfo["exons"] = sorted(tinfo["exons"])
        tinfo["cds"] = sorted(tinfo["cds"])
        tinfo["utr5"], tinfo["utr3"] = _compute_utrs(
            tinfo["exons"], tinfo["cds"], tinfo["strand"]
        )
        tinfo["utr"] = sorted(tinfo["utr5"] + tinfo["utr3"])

    return transcripts


def _compute_utrs(exons, cds, strand):
    """Compute 5' and 3' UTR regions from exon and CDS coordinates."""
    if not cds:
        return [], []

    cds_start = min(s for s, e in cds)
    cds_end = max(e for s, e in cds)

    utr5, utr3 = [], []
    for ex_s, ex_e in exons:
        if strand == "+":
            # 5'UTR: exon portion before CDS start
            if ex_s < cds_start:
                u_end = min(ex_e, cds_start - 1)
                if ex_s <= u_end:
                    utr5.append((ex_s, u_end))
            # 3'UTR: exon portion after CDS end
            if ex_e > cds_end:
                u_start = max(ex_s, cds_end + 1)
                if u_start <= ex_e:
                    utr3.append((u_start, ex_e))
        else:
            # Minus strand: 5'UTR at higher genomic coords
            if ex_e > cds_end:
                u_start = max(ex_s, cds_end + 1)
                if u_start <= ex_e:
                    utr5.append((u_start, ex_e))
            if ex_s < cds_start:
                u_end = min(ex_e, cds_start - 1)
                if ex_s <= u_end:
                    utr3.append((ex_s, u_end))

    return sorted(utr5), sorted(utr3)


# ---------------------------------------------------------------------------
# Gene search
# ---------------------------------------------------------------------------

def search_gene(gene_name: str, species: str = DEFAULT_SPECIES) -> Optional[Dict[str, Any]]:
    """
    Look up a gene by symbol using NCBI E-utilities.
    Returns gene info with transcript list (same format as ensembl_api).
    """
    gene_name = gene_name.strip()
    organism = _SPECIES_MAP.get(species, species.replace("_", " "))

    # Step 1: esearch → gene ID
    resp = _get(f"{EUTILS}/esearch.fcgi", {
        "db": "gene",
        "term": f"{gene_name}[sym] AND {organism}[orgn]",
        "retmode": "json",
    })
    ids = resp.json().get("esearchresult", {}).get("idlist", [])
    if not ids:
        return None

    gene_id = ids[0]

    # Step 2: esummary → gene info
    resp = _get(f"{EUTILS}/esummary.fcgi", {
        "db": "gene", "id": gene_id, "retmode": "json",
    })
    summary = resp.json().get("result", {}).get(gene_id, {})

    chrom = summary.get("chromosome", "")
    genomic_info = summary.get("genomicinfo", [])
    chr_accession = ""
    gene_start, gene_end = 0, 0
    strand = "+"

    if genomic_info:
        gi = genomic_info[0]
        chr_accession = gi.get("chraccver", "")
        cs, ce = gi.get("chrstart", 0), gi.get("chrstop", 0)
        # esummary uses 0-based coords; chrstart > chrstop means minus strand
        if cs <= ce:
            strand = "+"
            gene_start, gene_end = cs + 1, ce + 1
        else:
            strand = "-"
            gene_start, gene_end = ce + 1, cs + 1

    # Step 3: gene_table → per-transcript exon/CDS coords
    resp = _get(f"{EUTILS}/efetch.fcgi", {
        "db": "gene", "id": gene_id,
        "rettype": "gene_table", "retmode": "text",
    })
    transcripts_data = _parse_gene_table(
        resp.text, chrom, chr_accession, strand, gene_start, gene_end
    )

    # Fallback for prokaryotes: gene_table returns nothing because bacterial
    # genes have no annotated mRNA transcripts.  Synthesise a single-exon
    # transcript from the esummary genomic coordinates.
    if not transcripts_data and gene_start and gene_end:
        syn_id = f"{gene_name}_CDS"
        transcripts_data[syn_id] = {
            "transcript_name": f"{gene_name} (CDS)",
            "chrom": chrom or chr_accession,
            "chr_accession": chr_accession,
            "strand": strand,
            "exons": [(gene_start, gene_end)],
            "cds": [(gene_start, gene_end)],
            "utr5": [],
            "utr3": [],
            "utr": [],
        }

    # Cache all transcript details
    for tid, tinfo in transcripts_data.items():
        _transcript_cache[tid] = tinfo

    # Build transcript list
    transcripts = []
    for tid, tinfo in transcripts_data.items():
        transcripts.append({
            "id": tid,
            "name": tinfo.get("transcript_name", tid),
            "exon_count": len(tinfo.get("exons", [])),
            "strand": strand,
            "is_canonical": False,
        })

    # Sort: NM_ first, then by exon count descending
    transcripts.sort(key=lambda t: (0 if t["id"].startswith("NM_") else 1, -t["exon_count"]))

    # Mark first NM_ as canonical; if none, mark the first transcript
    for t in transcripts:
        if t["id"].startswith("NM_"):
            t["is_canonical"] = True
            break
    if transcripts and not any(t["is_canonical"] for t in transcripts):
        transcripts[0]["is_canonical"] = True

    return {
        "gene_name": gene_name,
        "gene_id": gene_id,
        "chrom": chrom,
        "strand": strand,
        "start": gene_start,
        "end": gene_end,
        "transcripts": transcripts,
    }


# ---------------------------------------------------------------------------
# Transcript details
# ---------------------------------------------------------------------------

def get_transcript_details(transcript_id: str) -> Optional[Dict[str, Any]]:
    """Get transcript details from cache (populated by search_gene)."""
    if transcript_id in _transcript_cache:
        return _transcript_cache[transcript_id]

    # Fallback: try to find the gene for this transcript
    try:
        resp = _get(f"{EUTILS}/esearch.fcgi", {
            "db": "gene",
            "term": f"{transcript_id}[accn]",
            "retmode": "json",
        })
        ids = resp.json().get("esearchresult", {}).get("idlist", [])
        if ids:
            # Get gene symbol
            resp2 = _get(f"{EUTILS}/esummary.fcgi", {
                "db": "gene", "id": ids[0], "retmode": "json",
            })
            sym = resp2.json().get("result", {}).get(ids[0], {}).get("name", "")
            if sym:
                search_gene(sym)
    except Exception:
        pass

    return _transcript_cache.get(transcript_id)


# ---------------------------------------------------------------------------
# Sequence fetching
# ---------------------------------------------------------------------------

def get_sequence_by_id(accession: str, seq_type: str = "genomic") -> Optional[str]:
    """Fetch sequence by RefSeq accession (NM_, NR_, etc.)."""
    return _fetch_fasta_seq({
        "db": "nucleotide", "id": accession,
        "rettype": "fasta", "retmode": "text",
    })


def get_region_sequence(chrom: str, start: int, end: int, strand: int = 1,
                        species: str = DEFAULT_SPECIES,
                        chr_accession: str = "") -> Optional[str]:
    """Fetch a genomic region sequence using NC_ accession."""
    if end < start:
        return ""

    acc = chr_accession or chrom
    if not acc.startswith("NC_"):
        # Can't fetch without NC_ accession
        print(f"  Warning: get_region_sequence needs NC_ accession, got '{acc}'")
        return None

    return _fetch_fasta_seq({
        "db": "nucleotide", "id": acc,
        "seq_start": str(start), "seq_stop": str(end),
        "strand": "1",  # Always fetch plus strand, app handles revcomp
        "rettype": "fasta", "retmode": "text",
    })


# ---------------------------------------------------------------------------
# High-level helpers (used by app.py)
# ---------------------------------------------------------------------------

def build_spliced_sequence(tinfo: dict, feature: str = "exons",
                           species: str = DEFAULT_SPECIES) -> Optional[str]:
    """
    Build spliced sequence. Uses single-call fetch by transcript accession.
    feature: 'exons' or 'cds'
    """
    intervals = tinfo.get(feature, [])
    if not intervals:
        return None

    transcript_id = tinfo.get("transcript_id", "")

    if transcript_id and feature == "exons":
        # Fetch full mRNA by accession (single call)
        seq = get_sequence_by_id(transcript_id)
        if seq:
            return seq.upper()

    if transcript_id and feature == "cds":
        # Fetch full mRNA, then extract CDS portion
        mrna = get_sequence_by_id(transcript_id)
        if mrna:
            cds_ann = cds_annotations_in_transcript_coords(tinfo)
            if cds_ann:
                cds_start = cds_ann[0][0]
                cds_end = cds_ann[-1][1]
                return mrna[cds_start:cds_end].upper()

    # Fallback: per-region fetch
    chr_acc = tinfo.get("chr_accession", "")
    strand = tinfo.get("strand", "+")
    intervals_sorted = sorted(intervals)

    parts = []
    for start, end in intervals_sorted:
        seq = get_region_sequence(tinfo["chrom"], start, end,
                                  chr_accession=chr_acc, species=species)
        if seq is None:
            return None
        parts.append(seq)

    full = "".join(parts)

    if strand == "-":
        comp = str.maketrans("ACGTacgt", "TGCAtgca")
        full = full.translate(comp)[::-1]

    return full.upper()


def build_genomic_sequence(tinfo: dict, species: str = DEFAULT_SPECIES) -> Optional[str]:
    """Fetch full genomic span including introns."""
    exons = tinfo.get("exons", [])
    if not exons:
        return None

    strand = tinfo["strand"]
    chr_acc = tinfo.get("chr_accession", "")
    gene_start = min(s for s, e in exons)
    gene_end = max(e for s, e in exons)

    seq = get_region_sequence(tinfo["chrom"], gene_start, gene_end,
                              chr_accession=chr_acc, species=species)
    if seq is None:
        return None

    if strand == "-":
        comp = str.maketrans("ACGTacgt", "TGCAtgca")
        seq = seq.translate(comp)[::-1]

    return seq.upper()


def get_flanking_sequence(tinfo: dict, upstream_bp: int, downstream_bp: int,
                          use_cds_anchor: bool = True,
                          species: str = DEFAULT_SPECIES) -> Tuple[str, str]:
    """Fetch upstream and downstream flanking sequences."""
    exons = tinfo.get("exons", [])
    cds = tinfo.get("cds", [])
    strand = tinfo["strand"]
    chr_acc = tinfo.get("chr_accession", "")

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
            upstream_seq = get_region_sequence(
                tinfo["chrom"], us, ue, chr_accession=chr_acc, species=species
            ) or ""

        downstream_seq = ""
        if downstream_bp > 0:
            ds = anchor_end + 1
            de = anchor_end + downstream_bp
            downstream_seq = get_region_sequence(
                tinfo["chrom"], ds, de, chr_accession=chr_acc, species=species
            ) or ""
    else:
        # Minus strand: upstream is at higher coords
        upstream_seq = ""
        if upstream_bp > 0:
            us = anchor_end + 1
            ue = anchor_end + upstream_bp
            raw = get_region_sequence(
                tinfo["chrom"], us, ue, chr_accession=chr_acc, species=species
            ) or ""
            comp = str.maketrans("ACGTacgt", "TGCAtgca")
            upstream_seq = raw.translate(comp)[::-1].upper()

        downstream_seq = ""
        if downstream_bp > 0:
            ds = max(1, anchor_start - downstream_bp)
            de = anchor_start - 1
            raw = get_region_sequence(
                tinfo["chrom"], ds, de, chr_accession=chr_acc, species=species
            ) or ""
            comp = str.maketrans("ACGTacgt", "TGCAtgca")
            downstream_seq = raw.translate(comp)[::-1].upper()

    return upstream_seq, downstream_seq


# ---------------------------------------------------------------------------
# CDS annotations (same logic as ensembl_api — pure computation)
# ---------------------------------------------------------------------------

def cds_annotations_in_transcript_coords(tinfo: dict) -> List[Tuple[int, int]]:
    """Map genomic CDS intervals -> transcript coords (0-based, end-exclusive)."""
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
