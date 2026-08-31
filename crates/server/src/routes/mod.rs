//! Route handlers. Each module ports one Flask route (or a small family of
//! related ones) from `backend/main.py`, matching its request/response
//! JSON shape and status-code behavior exactly (see the rewrite plan's
//! Phase 0 golden fixtures for the ground truth these are checked
//! against).

pub mod align;
pub mod analyze_primer;
pub mod blast;
pub mod design_arms;
pub mod design_conserved;
pub mod design_from_sequence;
pub mod design_primers;
pub mod design_probe;
pub mod gene;
pub mod idt;
pub mod search_variants;
pub mod sequence;

use engine::analyze::PrimerAnalysis;
use engine::backend::ThermoParams;
use serde::Deserialize;
use serde_json::Value;

pub(crate) const DEFAULT_SPECIES: &str = "homo_sapiens";

/// `cond.advanced` in every design route's request body — the same
/// four-key thermo shape everywhere (`primer_utils.py::_thermo_kwargs`'s
/// defaults apply when a key, or the whole object, is absent), plus the
/// two `PRIMER_MAX_POLY_X`/`PRIMER_MAX_NS_ACCEPTED` overrides that only
/// `/design_from_sequence` reads from this same object (`design_probe`
/// simply never populates them).
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct AdvancedThermo {
    pub mv_conc: Option<f64>,
    pub dv_conc: Option<f64>,
    pub dntp_conc: Option<f64>,
    pub dna_conc: Option<f64>,
    pub max_poly_x: Option<i32>,
    pub max_ns: Option<i32>,
}

impl AdvancedThermo {
    pub fn thermo_params(&self) -> ThermoParams {
        ThermoParams {
            mv_conc: self.mv_conc.unwrap_or(50.0),
            dv_conc: self.dv_conc.unwrap_or(1.5),
            dntp_conc: self.dntp_conc.unwrap_or(0.2),
            dna_conc: self.dna_conc.unwrap_or(50.0),
        }
    }
}

/// `main.py`'s shared `clean_seq` helper (used by `/design_from_sequence`
/// and `/design_probe`): strip, uppercase, keep only `ACGTN`.
pub(crate) fn clean_seq(s: &str) -> String {
    s.trim().to_uppercase().chars().filter(|c| matches!(c, 'A' | 'C' | 'G' | 'T' | 'N')).collect()
}

/// Primer3's raw, asymmetric oligo-position tuple: `(start, length)` for a
/// LEFT/internal oligo, `(right_end, length)` for a RIGHT oligo — the
/// convention `design_internal`/`design_probe`/`design_from_sequence`'s
/// unified path all serialize untouched (`results.get(f"PRIMER_LEFT_{i}")`
/// etc. in the Python originals never re-normalizes it). `interval` is the
/// already-normalized `[start, end)` every `engine` design module reports.
pub(crate) fn raw_tuple(interval: [i32; 2], is_right: bool) -> [i32; 2] {
    let (start, end) = (interval[0], interval[1]);
    if is_right { [end - 1, end - start] } else { [start, end - start] }
}

/// The *normalized* `[start, length]` form `design_flanking`/`design_junction`
/// compute themselves in Python (`a["position"] = [start, length]`,
/// distinct from `design_internal`'s raw-tuple convention above).
pub(crate) fn normalized_tuple(interval: [i32; 2]) -> [i32; 2] {
    [interval[0], interval[1] - interval[0]]
}

/// Flattens a `PrimerAnalysis`'s fields into a JSON object alongside extra
/// keys — mirrors Python's `{**analyze_primer(seq), "coords": ...}` dict-
/// spread idiom used throughout the design routes.
pub(crate) fn analysis_json_with(analysis: &PrimerAnalysis, extra: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut v = serde_json::to_value(analysis).expect("PrimerAnalysis always serializes");
    let obj = v.as_object_mut().expect("PrimerAnalysis serializes to a JSON object");
    for (k, val) in extra {
        obj.insert(k.to_string(), val);
    }
    v
}
