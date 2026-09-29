//! TaqMan probe design (`/design_probe`): a forward-strand pick over the
//! probe region with the probe Tm/size/GC window, every returned oligo
//! re-analysed through `analyze_primer`.

use crate::analyze::{analyze_primer, PrimerAnalysis};
use crate::backend::{ThermoBackend, ThermoParams};
use crate::defaults::{DEFAULT_PROBE_GC, DEFAULT_PROBE_SIZE, DEFAULT_PROBE_TM};
use crate::picker::{pick_in_region, CandidateConstraints, GcRange, OligoFilters, SizeRange, Strand, TmRange};

/// Overrides for `cond.probe_tm_*`/`probe_len_*`/`probe_gc_*`/`num_return`
/// in `main.py`'s request body. Each field is independently overridable
/// there (`if "probe_tm_min" in cond: base_args["PRIMER_INTERNAL_MIN_TM"] =
/// ...`, checked separately per key) — mirrored here with one `Option<f64>`/
/// `Option<i32>` per key, not a bundled `Option<TmConstraints>`, so
/// overriding just `probe_tm_min` leaves `probe_tm_opt`/`probe_tm_max` at
/// their TaqMan defaults exactly like Python does, rather than resetting
/// the whole triple.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProbeDesignOverrides {
    pub tm_min: Option<f64>,
    pub tm_opt: Option<f64>,
    pub tm_max: Option<f64>,
    pub size_min: Option<i32>,
    pub size_opt: Option<i32>,
    pub size_max: Option<i32>,
    pub gc_min: Option<f64>,
    pub gc_max: Option<f64>,
    pub num_return: Option<i32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DesignedProbe {
    pub analysis: PrimerAnalysis,
    /// `[start, end)` into the probe region.
    pub interval: [i32; 2],
}

/// `probe_region` must already be cleaned and at least 15bp — matching
/// `main.py`'s own 400-guard, which runs before this function is ever
/// reached; validation is the (future) server route's job, not this
/// crate's (architecture decision #3 — `crates/server` does
/// routing/validation/shaping, `engine` does the algorithms).
pub fn design_probe(
    backend: &dyn ThermoBackend,
    probe_region: &str,
    thermo: ThermoParams,
    overrides: ProbeDesignOverrides,
) -> (Vec<DesignedProbe>, String) {
    let probe_region = clean_seq(probe_region);

    let tm_opt = overrides.tm_opt.unwrap_or(DEFAULT_PROBE_TM.opt_tm);
    let tm_min = overrides.tm_min.unwrap_or(DEFAULT_PROBE_TM.min_tm);
    let tm_max = overrides.tm_max.unwrap_or(DEFAULT_PROBE_TM.max_tm);
    let size_opt = overrides.size_opt.unwrap_or(DEFAULT_PROBE_SIZE.opt_size as i32);
    let size_min = overrides.size_min.unwrap_or(DEFAULT_PROBE_SIZE.min_size as i32);
    let size_max = overrides.size_max.unwrap_or(DEFAULT_PROBE_SIZE.max_size as i32);
    let gc_min = overrides.gc_min.unwrap_or(DEFAULT_PROBE_GC.min_gc);
    let gc_max = overrides.gc_max.unwrap_or(DEFAULT_PROBE_GC.max_gc);
    let num_return = overrides.num_return.unwrap_or(5);

    let constraints = CandidateConstraints {
        size: SizeRange { min: size_min.max(1) as usize, opt: size_opt.max(1) as usize, max: size_max.max(1) as usize },
        tm: TmRange { min: tm_min, opt: tm_opt, max: tm_max },
        gc: GcRange { min: gc_min, max: gc_max },
    };
    let picked = pick_in_region(backend, &probe_region, (0, probe_region.len()), Strand::Forward, &constraints, &OligoFilters::default(), thermo, num_return.max(0) as usize);

    let probes = picked
        .oligos
        .iter()
        .map(|o| DesignedProbe { analysis: analyze_primer(backend, &o.sequence, thermo), interval: [o.candidate.start as i32, o.candidate.end as i32] })
        .collect();

    (probes, picked.explain())
}

fn clean_seq(s: &str) -> String {
    s.trim().to_uppercase().chars().filter(|c| matches!(c, 'A' | 'C' | 'G' | 'T' | 'N')).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;

    #[test]
    fn finds_taqman_probes_in_a_realistic_region() {
        let backend = NativeBackend;
        let region = "GCAGTCAGATCCTAGCGTCGAGCCCCCTCTGAGTCAGGAAACATTTTCAGACCTATGGAAACTACTTCCTGAAAACAACGTTCTGTCCCCCTTGCCGTCC";
        let (probes, explain) = design_probe(&backend, region, ThermoParams::default(), ProbeDesignOverrides::default());
        assert!(!probes.is_empty(), "expected at least one probe, explain: {explain:?}");
        for p in &probes {
            assert!(p.analysis.tm.unwrap() >= 60.0, "TaqMan probes should run hot: {:?}", p.analysis.tm);
            assert_eq!(p.interval[1] - p.interval[0], p.analysis.length as i32);
        }
    }
}
