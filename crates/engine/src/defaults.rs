//! Shared Primer3 constraint defaults, ported verbatim from
//! `primer_utils.py::default_primer3_args()`. Every design module starts
//! from these and layers overrides on top — kept as one source of truth
//! here too, for whichever backend (`Primer3Backend` today,
//! `NativeBackend` in Phase 5) ends up consuming them.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrimerSizeConstraints {
    pub opt_size: u32,
    pub min_size: u32,
    pub max_size: u32,
}

pub const DEFAULT_PRIMER_SIZE: PrimerSizeConstraints = PrimerSizeConstraints { opt_size: 20, min_size: 18, max_size: 25 };

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TmConstraints {
    pub opt_tm: f64,
    pub min_tm: f64,
    pub max_tm: f64,
}

pub const DEFAULT_PRIMER_TM: TmConstraints = TmConstraints { opt_tm: 62.0, min_tm: 57.0, max_tm: 67.0 };

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GcConstraints {
    pub min_gc: f64,
    pub max_gc: f64,
}

pub const DEFAULT_PRIMER_GC: GcConstraints = GcConstraints { min_gc: 40.0, max_gc: 60.0 };

pub const DEFAULT_NUM_RETURN: u32 = 5;

/// TaqMan probe (`PRIMER_INTERNAL_*`) defaults, from `main.py::design_probe`.
pub const DEFAULT_PROBE_TM: TmConstraints = TmConstraints { opt_tm: 70.0, min_tm: 65.0, max_tm: 75.0 };
pub const DEFAULT_PROBE_SIZE: PrimerSizeConstraints = PrimerSizeConstraints { opt_size: 22, min_size: 18, max_size: 30 };
pub const DEFAULT_PROBE_GC: GcConstraints = GcConstraints { min_gc: 30.0, max_gc: 80.0 };

/// Relaxed flanking/WGA (`primer_flanking.py`) constraints — genomic
/// flanks can be AT/GC-extreme, unlike coding sequence.
pub const FLANKING_PRIMER_TM: TmConstraints = TmConstraints { opt_tm: 62.0, min_tm: 52.0, max_tm: 68.0 };
pub const FLANKING_PRIMER_GC: GcConstraints = GcConstraints { min_gc: 20.0, max_gc: 80.0 };

/// Junction-mode (`primer_junction.py`) relaxed constraints — hardcoded
/// regardless of caller-supplied `primer_params`.
pub const JUNCTION_PRIMER_TM: TmConstraints = TmConstraints { opt_tm: 62.0, min_tm: 55.0, max_tm: 68.0 };
pub const JUNCTION_PRIMER_GC: GcConstraints = GcConstraints { min_gc: 35.0, max_gc: 65.0 };
pub const JUNCTION_MAX_TM_DIFF: f64 = 5.0;
pub const JUNCTION_DEFAULT_OVERLAP_MIN: u32 = 6;
pub const JUNCTION_DEFAULT_OVERLAP_MAX: u32 = 12;
pub const JUNCTION_DEFAULT_AMPLICON_MIN: u32 = 80;
pub const JUNCTION_DEFAULT_AMPLICON_MAX: u32 = 220;
pub const JUNCTION_DEFAULT_LEFT_PAD: u32 = 250;
pub const JUNCTION_DEFAULT_RIGHT_PAD: u32 = 400;
pub const JUNCTION_DEFAULT_MAX_CANDIDATES: u32 = 25;

pub const DEFAULT_MAX_POLY_X: u32 = 5;
pub const DEFAULT_MAX_NS_ACCEPTED: u32 = 0;

/// ARMS-PCR (`design_arms`) constraints — no Python original (new feature);
/// values follow standard ARMS/MAMA-PCR practice, not a port.
pub const ARMS_PRIMER_TM: TmConstraints = TmConstraints { opt_tm: 60.0, min_tm: 55.0, max_tm: 65.0 };
pub const ARMS_PRIMER_GC: GcConstraints = GcConstraints { min_gc: 30.0, max_gc: 70.0 };
pub const ARMS_MAX_TM_DIFF: f64 = 5.0;
pub const ARMS_DEFAULT_MISMATCH_OFFSET: u32 = 3;
pub const ARMS_DEFAULT_COMMON_PAD: u32 = 400;
pub const ARMS_DEFAULT_PRODUCT_MIN: u32 = 80;
pub const ARMS_DEFAULT_PRODUCT_MAX: u32 = 400;
pub const ARMS_DEFAULT_MAX_COMMON_CANDIDATES: u32 = 10;

/// Standard ARMS-PCR destabilizing-mismatch heuristic (purine↔C,
/// pyrimidine↔A) — an approximation, deliberately overridable via
/// `ArmsParams::mismatch_base`, not treated as gospel.
pub fn default_destabilizing_substitution(original: char) -> char {
    match original.to_ascii_uppercase() {
        'A' | 'G' => 'C',
        'C' | 'T' => 'A',
        other => other,
    }
}

/// One decimal place, matching `primer_utils.py::_round_or_none`.
pub fn round_or_none(x: Option<f64>) -> Option<f64> {
    x.map(|v| (v * 10.0).round() / 10.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_or_none_matches_python_round1() {
        assert_eq!(round_or_none(Some(62.34)), Some(62.3));
        assert_eq!(round_or_none(Some(62.35)), Some(62.4));
        assert_eq!(round_or_none(None), None);
    }
}
