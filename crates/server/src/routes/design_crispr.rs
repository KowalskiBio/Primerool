//! `POST /design_crispr`: SpCas9 guide RNAs in a region, each with the
//! cloning oligos for the requested vector.

use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use engine::backend_native::NativeBackend;
use engine::design_crispr::{cloning_oligos, design_guides, CloningVector, GuideOverrides};
use engine::defaults::CRISPR_SPACER_LEN;

use crate::error::AppError;
use crate::routes::{analysis_json_with, clean_seq, AdvancedThermo};

/// A protospacer plus its PAM is the shortest input that could contain
/// anything at all.
const MIN_REGION: usize = CRISPR_SPACER_LEN + 3;

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct DesignCrisprRequest {
    pub region: String,
    /// Added to every returned guide's coordinates, so the frontend gets
    /// positions in the space it cares about (e.g. gene coordinates) when
    /// it sends a slice of a longer sequence.
    pub offset: Option<i32>,
    pub conditions: Option<CrisprConditions>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct CrisprConditions {
    pub advanced: Option<AdvancedThermo>,
    pub gc_min: Option<f64>,
    pub gc_max: Option<f64>,
    pub num_return: Option<i32>,
    pub allow_poly_t: Option<bool>,
    /// `"pX330"` (the default) or `"lentiCRISPRv2"`.
    pub vector: Option<String>,
}

pub async fn design_crispr(Json(req): Json<DesignCrisprRequest>) -> Result<Json<Value>, AppError> {
    let region = clean_seq(&req.region);
    if region.len() < MIN_REGION {
        return Err(AppError::bad_request(format!("Region too short (need at least {MIN_REGION} bp for a 20 nt spacer plus its PAM)")));
    }

    let cond = req.conditions.unwrap_or_default();
    let thermo = cond.advanced.unwrap_or_default().thermo_params();
    let vector = match cond.vector.as_deref() {
        None => CloningVector::Px330,
        Some(v) => CloningVector::parse(v).ok_or_else(|| AppError::bad_request(format!("Unknown cloning vector {v:?} (expected pX330 or lentiCRISPRv2)")))?,
    };
    let offset = req.offset.unwrap_or(0);
    let overrides = GuideOverrides { gc_min: cond.gc_min, gc_max: cond.gc_max, num_return: cond.num_return, allow_poly_t: cond.allow_poly_t };

    // Scanning is CPU-bound synchronous work (a hairpin/dimer DP per
    // candidate spacer, and a long region yields many), so it goes to the
    // blocking pool rather than stalling an async worker — same reasoning
    // as `design_probe`.
    tokio::task::spawn_blocking(move || {
        let (guides, explain) = design_guides(&NativeBackend, &region, thermo, overrides);

        if guides.is_empty() {
            return Err(AppError::not_found(format!("No usable guides found. {explain}")));
        }

        let guides: Vec<Value> = guides
            .into_iter()
            .map(|g| {
                let oligos = cloning_oligos(&g.analysis.sequence, vector);
                analysis_json_with(
                    &g.analysis,
                    [
                        ("interval", json!([g.interval[0] + offset, g.interval[1] + offset])),
                        ("pam_interval", json!([g.pam_interval[0] + offset, g.pam_interval[1] + offset])),
                        ("strand", json!(g.strand.as_str())),
                        ("pam", json!(g.pam)),
                        ("cut_site", json!(g.cut_site + offset)),
                        ("score", json!(g.score)),
                        ("warnings", json!(g.warnings)),
                        ("cloning", json!(oligos)),
                    ],
                )
            })
            .collect();

        Ok(Json(json!({ "guides": guides, "explain": explain })))
    })
    .await
    .map_err(|e| AppError::server_error(format!("Server error: design task panicked: {e}")))?
}
