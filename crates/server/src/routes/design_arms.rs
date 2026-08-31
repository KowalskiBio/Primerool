//! `POST /design_arms` — SNP/indel ARMS-PCR allele-specific primer design.
//! New surface area, no Python original (see the primer-mode-revamp plan).
//! Follows `design_primers.rs`'s `spawn_blocking` + `_sync` split (CPU-bound
//! FFI work).
//!
//! Coordinate convention: `position` on every returned oligo is always the
//! normalized `[start, length]` form (matching flanking/junction — NOT
//! classic-internal's raw asymmetric tuple). This is new surface with no
//! legacy shape to preserve, so one convention is picked deliberately
//! rather than adding a fourth, undocumented variant — see
//! `frontend/src/api/design.ts`'s header comment.

use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use engine::backend_primer3::Primer3Backend;
use engine::design_arms::{design_arms_primers, Allele, ArmsCommonCandidate, ArmsDesignResult, ArmsError, ArmsParams, VariantSite};

use crate::error::AppError;
use crate::routes::{analysis_json_with, normalized_tuple, AdvancedThermo};

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct DesignArmsRequest {
    pub sequence: String,
    pub variant_pos: i64,
    pub ref_allele: String,
    pub alt_allele: String,
    pub mismatch_enabled: bool,
    pub mismatch_offset: i64,
    pub mismatch_base: Option<String>,
    pub common_pad: i64,
    pub product_min: i64,
    pub product_max: i64,
    pub max_common_candidates: i64,
    pub advanced: AdvancedThermo,
}

impl Default for DesignArmsRequest {
    fn default() -> Self {
        let defaults = ArmsParams::default();
        Self {
            sequence: String::new(),
            variant_pos: 0,
            ref_allele: String::new(),
            alt_allele: String::new(),
            mismatch_enabled: defaults.mismatch_enabled,
            mismatch_offset: defaults.mismatch_offset as i64,
            mismatch_base: None,
            common_pad: defaults.common_pad as i64,
            product_min: defaults.product_min as i64,
            product_max: defaults.product_max as i64,
            max_common_candidates: defaults.max_common_candidates as i64,
            advanced: AdvancedThermo::default(),
        }
    }
}

pub async fn design_arms(Json(req): Json<DesignArmsRequest>) -> Result<Json<Value>, AppError> {
    tokio::task::spawn_blocking(move || design_arms_sync(&req)).await.map_err(|e| AppError::server_error(format!("Server error: design task panicked: {e}")))?
}

fn allele_json(p: &engine::design_arms::ArmsAlleleSpecificPrimer) -> Value {
    analysis_json_with(
        &p.analysis,
        [
            ("interval", json!(p.interval)),
            ("position", json!(normalized_tuple(p.interval))),
            ("allele", json!(if matches!(p.allele, Allele::Ref) { "ref" } else { "alt" })),
            ("mismatch_position", json!(p.mismatch_position)),
        ],
    )
}

fn common_candidate_json(c: &ArmsCommonCandidate) -> Value {
    analysis_json_with(
        &c.analysis,
        [
            ("interval", json!(c.interval)),
            ("position", json!(normalized_tuple(c.interval))),
            ("product_size_ref", json!(c.product_size_ref)),
            ("product_size_alt", json!(c.product_size_alt)),
            ("pair_metrics_ref", json!(c.pair_metrics_ref)),
            ("pair_metrics_alt", json!(c.pair_metrics_alt)),
        ],
    )
}

fn design_arms_sync(req: &DesignArmsRequest) -> Result<Json<Value>, AppError> {
    if req.sequence.trim().is_empty() {
        return Err(AppError::bad_request("No sequence provided"));
    }
    if req.variant_pos < 0 {
        return Err(AppError::bad_request("variant_pos must be non-negative"));
    }
    if req.ref_allele.trim().is_empty() || req.alt_allele.trim().is_empty() {
        return Err(AppError::bad_request("ref_allele and alt_allele are required"));
    }

    let mismatch_base = match &req.mismatch_base {
        Some(s) if !s.is_empty() => Some(s.chars().next().unwrap()),
        _ => None,
    };

    let variant = VariantSite { pos: req.variant_pos as usize, ref_allele: req.ref_allele.clone(), alt_allele: req.alt_allele.clone() };
    let defaults = ArmsParams::default();
    let params = ArmsParams {
        mismatch_enabled: req.mismatch_enabled,
        mismatch_offset: if req.mismatch_offset > 0 { req.mismatch_offset as usize } else { defaults.mismatch_offset },
        mismatch_base,
        common_pad: if req.common_pad > 0 { req.common_pad as i32 } else { defaults.common_pad },
        product_min: if req.product_min > 0 { req.product_min as i32 } else { defaults.product_min },
        product_max: if req.product_max > 0 { req.product_max as i32 } else { defaults.product_max },
        max_common_candidates: if req.max_common_candidates > 0 { req.max_common_candidates as usize } else { defaults.max_common_candidates },
    };

    let backend = Primer3Backend;
    let thermo = req.advanced.thermo_params();
    let result: ArmsDesignResult = match design_arms_primers(&backend, &req.sequence, &variant, &params, thermo) {
        Ok(r) => r,
        Err(e @ (ArmsError::EmptyTemplate | ArmsError::EmptyAllele | ArmsError::VariantPosOutOfRange | ArmsError::RefAlleleMismatch { .. })) => {
            return Err(AppError::bad_request(format!("{e}")));
        }
        Err(e @ (ArmsError::NoValidPrimerWindow | ArmsError::NoCommonPrimersFound(_))) => {
            return Err(AppError::not_found(format!("{e}")));
        }
        Err(e @ ArmsError::Primer3(_)) => {
            return Err(AppError::server_error(format!("ARMS primer design failed: {e}")));
        }
    };

    Ok(Json(json!({
        "mode": "arms",
        "variant": { "pos": variant.pos, "ref_allele": variant.ref_allele, "alt_allele": variant.alt_allele },
        "ref_primer": allele_json(&result.ref_primer),
        "alt_primer": allele_json(&result.alt_primer),
        "common_candidates": result.common_candidates.iter().map(common_candidate_json).collect::<Vec<_>>(),
    })))
}
