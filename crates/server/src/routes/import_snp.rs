//! `POST /import_snp_blocks` — new surface, no legacy Python route. Parses
//! the per-SNP flanking-sequence `.docx` report format (`snp-import`) into
//! upstream/downstream flank pairs, ready to feed straight into flanking
//! design (`design_flanking_mode` in `design_primers.rs`) for every SNP in
//! one batch. `docx_base64` is the whole `.docx` file, base64-encoded
//! client-side; `text` is a best-effort fallback for a plain-text paste of
//! the same report (no summary table there, so `other_targets` is always
//! empty on that path).

use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};

use snp_import::{parse_docx, parse_pasted_text, ImportError, SnpBlock};

use crate::error::AppError;

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct ImportSnpRequest {
    pub docx_base64: Option<String>,
    pub text: Option<String>,
}

impl From<ImportError> for AppError {
    fn from(e: ImportError) -> Self {
        AppError::bad_request(e.to_string())
    }
}

fn block_json(b: &SnpBlock) -> Value {
    json!({
        "gene": b.gene,
        "rsid": b.rsid,
        "chrom": b.chrom,
        "position": b.position,
        "alleles": b.alleles,
        "refseq": b.refseq,
        "interval_start": b.interval_start,
        "interval_end": b.interval_end,
        "upstream_seq": b.upstream_seq,
        "downstream_seq": b.downstream_seq,
        "other_targets": b.other_targets,
    })
}

pub async fn import_snp_blocks(Json(req): Json<ImportSnpRequest>) -> Result<Json<Value>, AppError> {
    tokio::task::spawn_blocking(move || import_snp_blocks_sync(&req))
        .await
        .map_err(|e| AppError::server_error(format!("Server error: import task panicked: {e}")))?
}

fn import_snp_blocks_sync(req: &ImportSnpRequest) -> Result<Json<Value>, AppError> {
    let blocks = if let Some(b64) = req.docx_base64.as_deref().filter(|s| !s.is_empty()) {
        let cleaned: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
        let bytes = STANDARD.decode(&cleaned).map_err(|e| AppError::bad_request(format!("Invalid base64 .docx payload: {e}")))?;
        parse_docx(&bytes)?
    } else if let Some(text) = req.text.as_deref().filter(|s| !s.trim().is_empty()) {
        parse_pasted_text(text)?
    } else {
        return Err(AppError::bad_request("No docx_base64 or text provided"));
    };

    Ok(Json(json!({
        "blocks": blocks.iter().map(block_json).collect::<Vec<_>>(),
    })))
}
