//! `POST /get_sequence`, ported from `main.py::get_sequence`. The most
//! intricate route in the app — strand-aware flank/annotation logic with
//! several CDS-fallback branches the original author iterated on live
//! (see the inline comments preserved from `main.py`). Golden-fixture
//! replay (`crates/server/tests/golden.rs`) is the authoritative check
//! for this handler, not a read of this file alone.

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use providers::{Feature, Interval, Strand, TranscriptInfo};

use crate::error::AppError;
use crate::routes::DEFAULT_SPECIES;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct GetSequenceRequest {
    pub gene_name: String,
    pub transcript_id: Option<String>,
    pub species: String,
    pub api_source: String,
    pub upstream_bp: i64,
    pub downstream_bp: i64,
    pub include_introns: bool,
    pub include_utr: bool,
}

impl Default for GetSequenceRequest {
    fn default() -> Self {
        Self {
            gene_name: String::new(),
            transcript_id: None,
            species: String::new(),
            api_source: "ensembl".to_string(),
            upstream_bp: 0,
            downstream_bp: 0,
            include_introns: false,
            include_utr: false,
        }
    }
}

/// `main.py::clean_dna` — strip whitespace/newlines, uppercase, keep only
/// ACGTN.
fn clean_dna(s: &str) -> String {
    s.trim().to_uppercase().replace(' ', "").replace(['\n', '\r'], "").chars().filter(|c| "ACGTN".contains(*c)).collect()
}

/// `main.py::_blocks_for_spliced_sequence` — sorted blocks, reversed on
/// minus strand to give transcript-5'->3' order.
fn blocks_for_spliced_sequence(tinfo: &TranscriptInfo, feature: Feature) -> Vec<Interval> {
    let mut blocks: Vec<Interval> = match feature {
        Feature::Exons => tinfo.exons.clone(),
        Feature::Cds => tinfo.cds.clone(),
    };
    if blocks.is_empty() {
        return blocks;
    }
    blocks.sort();
    if tinfo.strand == Strand::Minus {
        blocks.reverse();
    }
    blocks
}

/// `main.py::_junctions_from_blocks`.
fn junctions_from_blocks(blocks: &[Interval]) -> Vec<Value> {
    let mut junctions = Vec::new();
    let mut cum: u64 = 0;
    for (i, &(s, e)) in blocks.iter().enumerate() {
        cum += e - s + 1;
        if i < blocks.len() - 1 {
            junctions.push(json!({ "index": i, "pos": cum, "label": format!("Exon {}|{}", i + 1, i + 2) }));
        }
    }
    junctions
}

pub async fn get_sequence(State(state): State<AppState>, Json(req): Json<GetSequenceRequest>) -> Result<Json<Value>, AppError> {
    let gene_name = req.gene_name.trim().to_string();
    let species = {
        let s = req.species.trim();
        if s.is_empty() { DEFAULT_SPECIES.to_string() } else { s.to_string() }
    };
    let provider = state.provider(&req.api_source);

    let transcript_id = req.transcript_id.filter(|t| !t.is_empty());
    if gene_name.is_empty() || transcript_id.is_none() {
        return Err(AppError::bad_request("Please provide gene_name and transcript_id"));
    }
    let transcript_id = transcript_id.unwrap();

    let upstream_bp = req.upstream_bp.max(0) as u64;
    let downstream_bp = req.downstream_bp.max(0) as u64;
    let mut include_utr = req.include_utr;
    let include_introns = req.include_introns;

    let tinfo = provider.get_transcript_details(&transcript_id).await?.ok_or_else(|| AppError::not_found(format!("Transcript {transcript_id} not found in Ensembl")))?;

    if tinfo.exons.is_empty() {
        return Err(AppError::server_error("No exon coordinates found for transcript"));
    }

    let chrom = tinfo.chrom.clone();
    let strand = tinfo.strand;
    // 1-based inclusive genomic span of the transcript's exons — the
    // coordinate the frontend needs to map an Ensembl variant hit's
    // genomic position into a local index in `gene_seq` (only exact when
    // `include_introns` is true, since only then is `gene_seq` the linear
    // genomic template).
    let gene_start_genomic = tinfo.exons.iter().map(|(s, _)| *s).min().unwrap();
    let gene_end_genomic = tinfo.exons.iter().map(|(_, e)| *e).max().unwrap();

    let (upstream_seq, downstream_seq) = provider.get_flanking_sequence(&tinfo, upstream_bp, downstream_bp, !tinfo.cds.is_empty(), &species).await?;
    let upstream_seq = clean_dna(&upstream_seq);
    let downstream_seq = clean_dna(&downstream_seq);

    // ALWAYS compute exon-only spliced template for junction primers.
    let spliced_exons_seq = provider.build_spliced_sequence(&tinfo, Feature::Exons, &species).await?.unwrap_or_default();
    let exon_blocks = blocks_for_spliced_sequence(&tinfo, Feature::Exons);
    let junctions = junctions_from_blocks(&exon_blocks);

    let mut annotations: Vec<Value> = Vec::new();
    let gene_seq: String;
    let spliced_seq: String;

    if include_introns {
        gene_seq = clean_dna(&provider.build_genomic_sequence(&tinfo, &species).await?.unwrap_or_default());
        if gene_seq.is_empty() {
            return Err(AppError::server_error("Failed to fetch genomic sequence"));
        }

        let exon_span_start = tinfo.exons.iter().map(|(s, _)| *s).min().unwrap();
        let exon_span_end = tinfo.exons.iter().map(|(_, e)| *e).max().unwrap();
        let total_len = exon_span_end - exon_span_start + 1;

        for &(exon_start, exon_end) in &tinfo.exons {
            let mut rel_start = exon_start - exon_span_start;
            let mut rel_end = (exon_end - exon_span_start) + 1;
            if strand == Strand::Minus {
                let (new_start, new_end) = (total_len - rel_end, total_len - rel_start);
                rel_start = new_start;
                rel_end = new_end;
            }
            annotations.push(json!({ "start": rel_start, "end": rel_end, "type": "exon" }));
        }

        for &(cds_start, cds_end) in &tinfo.cds {
            if cds_end < exon_span_start || cds_start > exon_span_end {
                continue;
            }
            let cds_start = cds_start.max(exon_span_start);
            let cds_end = cds_end.min(exon_span_end);
            let mut rel_start = cds_start - exon_span_start;
            let mut rel_end = (cds_end - exon_span_start) + 1;
            if strand == Strand::Minus {
                let (new_start, new_end) = (total_len - rel_end, total_len - rel_start);
                rel_start = new_start;
                rel_end = new_end;
            }
            annotations.push(json!({ "start": rel_start, "end": rel_end, "type": "cds" }));
        }

        annotations.sort_by(|a, b| {
            let ta = a["type"].as_str().unwrap();
            let tb = b["type"].as_str().unwrap();
            let sa = a["start"].as_u64().unwrap();
            let sb = b["start"].as_u64().unwrap();
            ta.cmp(tb).then(sa.cmp(&sb))
        });

        let mut feature_display = if include_utr { Feature::Exons } else { Feature::Cds };
        let mut ss = provider.build_spliced_sequence(&tinfo, feature_display, &species).await?.unwrap_or_default();
        if matches!(feature_display, Feature::Cds) && ss.is_empty() {
            feature_display = Feature::Exons;
            ss = provider.build_spliced_sequence(&tinfo, feature_display, &species).await?.unwrap_or_default();
            include_utr = true;
        }
        spliced_seq = ss;
    } else {
        let mut feature_display = if include_utr { Feature::Exons } else { Feature::Cds };
        let mut gs = provider.build_spliced_sequence(&tinfo, feature_display, &species).await?;

        if gs.as_deref().map(str::is_empty).unwrap_or(true) {
            if matches!(feature_display, Feature::Cds) {
                feature_display = Feature::Exons;
                gs = provider.build_spliced_sequence(&tinfo, feature_display, &species).await?;
                include_utr = true;
            }
            if gs.as_deref().map(str::is_empty).unwrap_or(true) {
                return Err(AppError::server_error("Transcript sequence extraction failed"));
            }
        }
        gene_seq = gs.unwrap();
        spliced_seq = gene_seq.clone();

        if include_utr {
            let cds_ann = providers::coords::cds_annotations_in_transcript_coords(&tinfo);
            annotations = cds_ann.iter().map(|(s, e)| json!({ "start": s, "end": e, "type": "cds" })).collect();

            let mut curr: u64 = 0;
            for (start, end) in blocks_for_spliced_sequence(&tinfo, Feature::Exons) {
                let len = end - start + 1;
                annotations.push(json!({ "start": curr, "end": curr + len, "type": "exon" }));
                curr += len;
            }
        } else {
            // CDS-only mode: gene_seq IS the CDS. Preserve CDS-block
            // structure as "exon" (for mapping/base color) and "cds" (for
            // color) annotations so junction visuals still work even
            // without a UTR — mirrors main.py's own reasoning comment.
            let cds_blocks = blocks_for_spliced_sequence(&tinfo, Feature::Cds);
            let mut curr: u64 = 0;
            for (start, end) in cds_blocks {
                let len = end - start + 1;
                annotations.push(json!({ "start": curr, "end": curr + len, "type": "exon" }));
                annotations.push(json!({ "start": curr, "end": curr + len, "type": "cds" }));
                curr += len;
            }
        }
    }

    let utr5_len: u64 = tinfo.utr5.iter().map(|(s, e)| e - s + 1).sum();

    Ok(Json(json!({
        "gene_name": gene_name,
        "transcript_id": transcript_id,
        "transcript_name": if tinfo.transcript_name.is_empty() { transcript_id.clone() } else { tinfo.transcript_name.clone() },
        "chrom": chrom,
        "strand": strand.as_str(),
        "gene_start_genomic": gene_start_genomic,
        "gene_end_genomic": gene_end_genomic,

        "upstream_len": upstream_seq.len(),
        "gene_len": gene_seq.len(),
        "downstream_len": downstream_seq.len(),
        "utr5_len": utr5_len,

        "upstream_seq": upstream_seq,
        "gene_seq": gene_seq,
        "downstream_seq": downstream_seq,

        "spliced_seq": spliced_seq,
        "spliced_exons_seq": spliced_exons_seq,

        "junctions": junctions,
        "annotations": annotations,
        "include_introns": include_introns,
        "include_utr": include_utr,
    })))
}
