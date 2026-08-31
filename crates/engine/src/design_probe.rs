//! Port of `main.py`'s `/design_probe` handler (TaqMan internal-oligo
//! design). Unlike `design_internal`, Python re-analyzes every returned
//! oligo through `analyze_primer` (independent `primer3.bindings.calc_tm`/
//! `calc_hairpin`/`calc_homodimer` calls) rather than trusting
//! `choose_primers`' own `PRIMER_INTERNAL_i_TM`/`GC_PERCENT` fields —
//! mirrored here via `engine::analyze::analyze_primer`, generic over
//! `ThermoBackend` so this module works unchanged once probes are
//! re-targeted onto `NativeBackend`.

use primer3_ffi::design::{design_primers, GlobalSettings, SeqArgs};
use primer3_ffi::Primer3Error;

use crate::analyze::{analyze_primer, PrimerAnalysis};
use crate::backend::{ThermoBackend, ThermoParams};
use crate::defaults::{DEFAULT_PROBE_GC, DEFAULT_PROBE_SIZE, DEFAULT_PROBE_TM};

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
    /// `[start, end)` — matches `main.py`'s raw `coords` field being the
    /// primer3 `(start, length)` tuple; normalized here like every other
    /// oligo interval in this crate.
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
) -> Result<(Vec<DesignedProbe>, Option<String>), Primer3Error> {
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

    let mut gs = GlobalSettings::new();
    gs.set_pick_primers(false, false);
    gs.set_pick_internal_oligo(true);
    gs.set_internal_oligo_size(size_opt, size_min, size_max);
    gs.set_internal_oligo_tm(tm_opt, tm_min, tm_max);
    gs.set_internal_oligo_gc(gc_min, gc_max);
    // `main.py` builds a `therm_params` dict from `adv` (with real user
    // overrides for all four fields) but only ever writes it into
    // `PRIMER_SALT_MONOVALENT`/`PRIMER_SALT_DIVALENT`/`PRIMER_DNTP_CONC`/
    // `PRIMER_DNA_CONC` — the *primer* (LEFT/RIGHT) salt fields, never the
    // `PRIMER_INTERNAL_*` ones `choose_primers` actually reads for internal-
    // oligo picking (irrelevant here since `PICK_LEFT_PRIMER`/
    // `PICK_RIGHT_PRIMER` are both 0). This is a real, permanent bug in the
    // Python source, confirmed by a parity mismatch against real
    // `primer3-py` output when this port instead threaded the user's
    // `thermo` param through to `set_internal_oligo_salt_conc`: candidate
    // *selection* always runs at primer3's true C-level internal-oligo
    // salt defaults (`50.0, 0.0, 0.0, 50.0` — confirmed empirically, not
    // `1.5`/`0.2` like the general primer defaults) regardless of what a
    // caller passes for `dv_conc`/`dntp_conc`; only the QC *re-analysis*
    // step below (`analyze_primer`) actually applies the caller's real
    // `thermo`. Preserved exactly, not "fixed", since fixing it would
    // change which probes get selected, not just how they're reported.
    gs.set_internal_oligo_salt_conc(50.0, 0.0, 0.0, 50.0);
    gs.set_num_return(num_return);

    let mut sa = SeqArgs::new(&probe_region)?;
    let result = design_primers(&gs, &mut sa)?;

    let probes = result
        .internal_candidates
        .iter()
        .map(|oligo| DesignedProbe {
            analysis: analyze_primer(backend, &oligo.sequence, thermo),
            interval: [oligo.start, oligo.end],
        })
        .collect();

    Ok((probes, result.internal_explain))
}

fn clean_seq(s: &str) -> String {
    s.trim().to_uppercase().chars().filter(|c| matches!(c, 'A' | 'C' | 'G' | 'T' | 'N')).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_primer3::Primer3Backend;

    #[test]
    fn finds_taqman_probes_in_a_realistic_region() {
        let backend = Primer3Backend;
        // GC-rich enough to clear the TaqMan 65-75C Tm window under
        // primer3's real (never user-overridable, see the comment above)
        // internal-oligo salt defaults of 0mM divalent/dNTP.
        let region = "GCAGTCAGATCCTAGCGTCGAGCCCCCTCTGAGTCAGGAAACATTTTCAGACCTATGGAAACTACTTCCTGAAAACAACGTTCTGTCCCCCTTGCCGTCC";
        let (probes, explain) = design_probe(&backend, region, ThermoParams::default(), ProbeDesignOverrides::default()).unwrap();
        assert!(!probes.is_empty(), "expected at least one probe, explain: {explain:?}");
        for p in &probes {
            assert!(p.analysis.tm.unwrap() >= 60.0, "TaqMan probes should run hot: {:?}", p.analysis.tm);
            assert_eq!(p.interval[1] - p.interval[0], p.analysis.length as i32);
        }
    }
}
