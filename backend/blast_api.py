"""
blast_api.py — NCBI BLAST sequence identification via the BLAST URL API.
Submits a nucleotide sequence, polls for results, and parses the top hits
to identify organism, gene symbol, and RefSeq accession.
"""

import re
import time
import requests
import xml.etree.ElementTree as ET
from typing import Optional, List, Dict, Any

BLAST_URL = "https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi"

# NCBI usage policy: >=10s between any calls, >=60s between polls for same RID
_POLL_INTERVAL = 10  # Reduced to 10s (minimum per NCBI policy) to speed up checks
_MAX_WAIT = 180      # max seconds to wait before giving up


def submit_blast(sequence: str, database: str = "nt",
                 hitlist_size: int = 10) -> dict:
    """
    Submit a BLAST search. Returns {'rid': ..., 'rtoe': ...}.
    Defaults to 'nt' database for broader genomic coverage.
    """
    params = {
        "CMD": "Put",
        "PROGRAM": "blastn",
        "DATABASE": database,
        "QUERY": sequence,
        "HITLIST_SIZE": str(hitlist_size),
        "FORMAT_TYPE": "XML",  # Use XML for stability
        "MEGABLAST": "on",
        "tool": "primeroonline",
    }

    # Use POST to support long sequences (>2k bp)
    resp = requests.post(BLAST_URL, data=params, timeout=30)
    resp.raise_for_status()

    rid_match = re.search(r"RID = (\S+)", resp.text)
    rtoe_match = re.search(r"RTOE = (\d+)", resp.text)

    if not rid_match:
        raise RuntimeError("Failed to parse RID from NCBI BLAST response")

    return {
        "rid": rid_match.group(1),
        "rtoe": int(rtoe_match.group(1)) if rtoe_match else 30,
    }


def poll_blast(rid: str, max_wait: int = _MAX_WAIT) -> bool:
    """
    Poll NCBI BLAST for job completion. Returns True when ready.
    Raises on failure or timeout.
    """
    elapsed = 0
    while elapsed < max_wait:
        time.sleep(_POLL_INTERVAL)
        elapsed += _POLL_INTERVAL

        resp = requests.get(BLAST_URL, params={
            "CMD": "Get",
            "FORMAT_OBJECT": "SearchInfo",
            "RID": rid,
        }, timeout=30)

        text = resp.text
        if "Status=READY" in text:
            return True
        if "Status=FAILED" in text:
            raise RuntimeError("NCBI BLAST search failed")
        if "Status=UNKNOWN" in text:
            raise RuntimeError("NCBI BLAST RID unknown or expired")
        # Status=WAITING — keep polling

    raise TimeoutError(f"BLAST search did not complete within {max_wait}s")


def get_blast_results(rid: str) -> str:
    """
    Retrieve BLAST results in XML format.
    Returns the raw XML string.
    """
    resp = requests.get(BLAST_URL, params={
        "CMD": "Get",
        "FORMAT_TYPE": "XML",
        "RID": rid,
    }, timeout=60)
    resp.raise_for_status()
    return resp.text


def parse_blast_results(xml_data: str) -> List[Dict[str, Any]]:
    """
    Extract top hits from BLAST XML output.
    Returns list of dicts with organism, gene_symbol, accession, etc.
    """
    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError as e:
        raise RuntimeError(f"Failed to parse BLAST XML: {e}")

    # XML structure: BlastOutput -> BlastOutput_iterations -> Iteration -> Iteration_hits -> Hit
    hits_node = root.find(".//Iteration_hits")
    if hits_node is None:
        return []
    
    query_len_node = root.find(".//BlastOutput_query-len")
    query_len = int(query_len_node.text) if query_len_node is not None else 0

    results = []
    
    for hit in hits_node.findall("Hit"):
        hit_def = hit.find("Hit_def")
        hit_acc = hit.find("Hit_accession")
        
        title = hit_def.text if hit_def is not None else "Unknown"
        accession = hit_acc.text if hit_acc is not None else ""
        
        # Heuristic for organism: First 2 words of title
        # e.g. "Borrelia hermsii strain..." -> "Borrelia hermsii"
        # This is used for mapping to Ensembl species.
        parts = title.split()
        if len(parts) >= 2:
            organism = f"{parts[0]} {parts[1]}"
        else:
            organism = parts[0] if parts else "Unknown"

        # Heuristic for gene symbol from title
        # "Organism gene_name (SYMBOL), mRNA" or "... (SYMBOL) gene ..."
        gene_symbol = None
        
        # Pattern 1: (SYMBOL) - now allowing hyphens/dots e.g. HLA-DQB1 or TRIM2.1
        # match = re.search(r"\((\w+)\)", title) 
        # Better: \(([\w\-\.]+)\)
        
        # prioritizing explicit "(SYMBOL) gene" or "transcript variant" patterns?
        # Actually, looking at the failing case: "... (HLA-DQB1) gene ..."
        # The previous regex `\((\w+)\)` failed because of the hyphen.
        
        gene_match = re.search(r"\(([\w\-\.]+)\)", title)
        if gene_match:
            gene_symbol = gene_match.group(1)
            
        # Fallback: sometimes it's just "SYMBOL transcript variant" without parens?
        # For now, let's stick to modifying the parens regex which is safer.

        hsps = hit.find("Hit_hsps")
        if hsps is None:
            continue
            
        # Take the first High-scoring Segment Pair (HSP)
        best_hsp = hsps.find("Hsp")
        if best_hsp is None:
            continue

        def get_text(tag):
            node = best_hsp.find(tag)
            return node.text if node is not None else None
            
        evalue = get_text("Hsp_evalue")
        bit_score = get_text("Hsp_bit-score")
        
        identity = int(get_text("Hsp_identity") or 0)
        align_len = int(get_text("Hsp_align-len") or 1)
        identity_pct = round(100.0 * identity / align_len, 1) if align_len else 0
        query_from = int(get_text("Hsp_query-from") or 0)
        query_to = int(get_text("Hsp_query-to") or 0)
        query_cover = round(100.0 * (abs(query_to - query_from) + 1) / query_len) if query_len else 0

        results.append({
            "organism": organism,
            # "taxid": taxid, # Not readily available in standard XML Hit object
            "gene_symbol": gene_symbol,
            "accession": accession,
            "title": title,
            "evalue": float(evalue) if evalue else None,
            "bit_score": float(bit_score) if bit_score else None,
            "identity_pct": identity_pct,
            "query_cover": query_cover,
            "query_from": query_from,
            "query_to": query_to,
            "hit_from": int(get_text("Hsp_hit-from") or 0),
            "hit_to": int(get_text("Hsp_hit-to") or 0),
            "query_len": query_len,
        })

    return results


# Map common NCBI organism names to Ensembl species codes
_SPECIES_MAP = {
    # Animals / Vertebrates
    "homo sapiens": "homo_sapiens",
    "mus musculus": "mus_musculus",
    "rattus norvegicus": "rattus_norvegicus",
    "danio rerio": "danio_rerio",
    "gallus gallus": "gallus_gallus",
    "drosophila melanogaster": "drosophila_melanogaster",
    "caenorhabditis elegans": "caenorhabditis_elegans",
    "xenopus tropicalis": "xenopus_tropicalis",
    "sus scrofa": "sus_scrofa",
    "bos taurus": "bos_taurus",
    "ovis aries": "ovis_aries",
    "canis lupus familiaris": "canis_lupus_familiaris",
    "felis catus": "felis_catus",
    "macaca mulatta": "macaca_mulatta",
    "pan troglodytes": "pan_troglodytes",
    "oryctolagus cuniculus": "oryctolagus_cuniculus",
    # Fungi
    "saccharomyces cerevisiae": "saccharomyces_cerevisiae",
    "schizosaccharomyces pombe": "schizosaccharomyces_pombe",
    "aspergillus nidulans": "aspergillus_nidulans",
    "neurospora crassa": "neurospora_crassa",
    "candida albicans": "candida_albicans",
    # Plants
    "arabidopsis thaliana": "arabidopsis_thaliana",
    "oryza sativa": "oryza_sativa",
    "zea mays": "zea_mays",
    "triticum aestivum": "triticum_aestivum",
    "solanum lycopersicum": "solanum_lycopersicum",
    "glycine max": "glycine_max",
    "vitis vinifera": "vitis_vinifera",
    "solanum tuberosum": "solanum_tuberosum",
    "hordeum vulgare": "hordeum_vulgare",
    "nicotiana tabacum": "nicotiana_tabacum",
    # Bacteria (Ensembl Bacteria requires GCA accession suffix)
    "escherichia coli": "escherichia_coli_str_k_12_substr_mg1655_gca_000005845",
    "bacillus subtilis": "bacillus_subtilis_subsp_subtilis_str_168_gca_000009045",
    "staphylococcus aureus": "staphylococcus_aureus_subsp_aureus_nctc_8325_gca_000013425",
    "pseudomonas aeruginosa": "pseudomonas_aeruginosa_pao1_gca_000006765",
    "mycobacterium tuberculosis": "mycobacterium_tuberculosis_h37ra_gca_000016145",
    "salmonella enterica": "salmonella_enterica_subsp_enterica_serovar_typhimurium_str_lt2_gca_000006945",
    "streptococcus pneumoniae": "streptococcus_pneumoniae_tigr4_gca_000006885",
    # Protists
    "plasmodium falciparum": "plasmodium_falciparum",
    "trypanosoma brucei": "trypanosoma_brucei",
    "leishmania major": "leishmania_major",
    "toxoplasma gondii": "toxoplasma_gondii_me49",
    "dictyostelium discoideum": "dictyostelium_discoideum",
}


def organism_to_ensembl_species(organism: str) -> Optional[str]:
    """
    Convert an NCBI organism name to an Ensembl species code.
    Returns None if no mapping is found.
    """
    key = organism.strip().lower()
    if key in _SPECIES_MAP:
        return _SPECIES_MAP[key]
    # Try generic conversion: lowercase, replace spaces with underscores
    candidate = key.replace(" ", "_")
    return candidate


def run_blast(sequence: str) -> List[Dict[str, Any]]:
    """
    Full BLAST pipeline: submit, poll, retrieve, parse.
    Blocking call — may take up to ~3 minutes.
    """
    info = submit_blast(sequence)
    rid = info["rid"]
    rtoe = info["rtoe"]

    print(f"BLAST submitted: RID={rid}, estimated wait={rtoe}s", flush=True)

    # Note: We skip the long 'initial_wait' (rtoe) and rely on the polling loop
    # with a 10s interval. This allows us to catch fast completion earlier
    # while adhering to the >=10s policy.

    poll_blast(rid, max_wait=_MAX_WAIT)

    data = get_blast_results(rid)
    return parse_blast_results(data)
