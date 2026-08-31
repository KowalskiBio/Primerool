//! Safe wrapper over [`primer3_sys`]'s thermodynamic primitives.
//!
//! Exposes exactly the call shapes `primer_utils.py`'s `analyze_primer`/
//! `analyze_pair` need: `calc_tm` (-> `seqtm()`), `calc_hairpin`,
//! `calc_homodimer`, `calc_heterodimer` (-> `thal()` with different
//! alignment-type/dimer-flag combinations). Every non-varying parameter
//! Primerool never overrides (`dmso_conc`, `dmso_fact`, `formamide_conc`,
//! `annealing_temp_c`, `max_nn_length`, `tm_method`, `salt_corrections`,
//! `temp_c`, `max_loop`) is hardcoded here to primer3-py's own library
//! defaults, matching Primerool's actual real-world call sites exactly
//! (`primer_utils.py::_thermo_kwargs` only ever varies `mv_conc`/`dv_conc`/
//! `dntp_conc`/`dna_conc`).
//!
//! **Concurrency**: all calls are serialized behind a single global
//! `Mutex`. `thalflex.c` was patched by primer3-py's maintainers to remove
//! most function-local `static` mutable state for thread-safety, but this
//! hasn't been independently audited here across the full ~3400-line file,
//! and `thal()`'s internal parameter-table initialization
//! (`get_thermodynamic_values`) definitely populates process-global state
//! once at startup. Serializing calls is the conservative, correctness-first
//! choice for a from-scratch FFI binding; these calls are microsecond-scale,
//! so this is not expected to be a throughput bottleneck — revisit only if
//! profiling shows otherwise.

use std::ffi::CString;
use std::sync::{Mutex, OnceLock};

use primer3_sys as sys;

pub mod design;

#[derive(Debug, thiserror::Error)]
pub enum Primer3Error {
    #[error("failed to load default thermodynamic parameters: {0}")]
    ParameterLoadFailed(String),
    #[error("sequence contains an interior NUL byte")]
    InteriorNul,
    #[error("primer3 call failed: {0}")]
    CallFailed(String),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThermoResult {
    pub structure_found: bool,
    pub tm: Option<f64>,
    pub dg: Option<f64>,
}

// primer3-py's Primer3PyArguments library defaults for everything
// Primerool's call sites never override (see module docs).
const DMSO_CONC: f64 = 0.0;
const DMSO_FACT: f64 = 0.6;
const FORMAMIDE_CONC: f64 = 0.0;
const ANNEALING_TEMP_C: f64 = -10.0;
const MAX_NN_LENGTH: i32 = 60;
const TEMP_C_DEFAULT: f64 = 37.0;
const MAX_LOOP_DEFAULT: i32 = 30;
const TM_METHOD_SANTALUCIA: sys::tm_method_type = sys::tm_method_type_santalucia_auto;
const SALT_CORRECTIONS_SANTALUCIA: sys::salt_correction_type = sys::salt_correction_type_santalucia;

static INIT: OnceLock<()> = OnceLock::new();
static THAL_CALL_LOCK: Mutex<()> = Mutex::new(());

fn ensure_initialized() {
    INIT.get_or_init(|| unsafe {
        let mut params: sys::thal_parameters = std::mem::zeroed();
        let mut results: sys::thal_results = std::mem::zeroed();

        let rc = sys::set_default_thal_parameters(&mut params);
        assert_eq!(rc, 0, "set_default_thal_parameters failed");

        let rc = sys::get_thermodynamic_values(&params, &mut results);
        if rc != 0 {
            let msg = c_char_array_to_string(&results.msg);
            panic!("get_thermodynamic_values failed: {msg}");
        }

        sys::thal_free_parameters(&mut params);
    });
}

fn c_char_array_to_string(buf: &[std::os::raw::c_char]) -> String {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn to_cstring(seq: &str) -> Result<CString, Primer3Error> {
    CString::new(seq).map_err(|_| Primer3Error::InteriorNul)
}

/// `oligotm.h::seqtm()` — NN thermodynamics up to 60bp, a GC%-based formula
/// beyond that, matching `primer3.bindings.calc_tm`'s documented behavior
/// exactly.
pub fn calc_tm(seq: &str, mv_conc: f64, dv_conc: f64, dntp_conc: f64, dna_conc: f64) -> Result<f64, Primer3Error> {
    ensure_initialized();
    let seq_c = to_cstring(seq)?;
    let _guard = THAL_CALL_LOCK.lock().unwrap();
    let ret = unsafe {
        sys::seqtm(
            seq_c.as_ptr(),
            dna_conc,
            mv_conc,
            dv_conc,
            dntp_conc,
            DMSO_CONC,
            DMSO_FACT,
            FORMAMIDE_CONC,
            MAX_NN_LENGTH,
            TM_METHOD_SANTALUCIA,
            SALT_CORRECTIONS_SANTALUCIA,
            ANNEALING_TEMP_C,
        )
    };
    Ok(ret.Tm)
}

fn make_thal_args(mv_conc: f64, dv_conc: f64, dntp_conc: f64, dna_conc: f64, alignment_type: sys::thal_alignment_type, dimer: bool) -> sys::thal_args {
    sys::thal_args {
        type_: alignment_type,
        maxLoop: MAX_LOOP_DEFAULT,
        mv: mv_conc,
        dv: dv_conc,
        dntp: dntp_conc,
        dna_conc,
        temp: TEMP_C_DEFAULT + 273.15, // thal_args.temp is Kelvin (see thalflex.c::set_thal_default_args)
        dimer: dimer as std::os::raw::c_int,
    }
}

fn run_thal(oligo1: &str, oligo2: &str, args: &sys::thal_args, mode: sys::thal_mode) -> Result<ThermoResult, Primer3Error> {
    ensure_initialized();
    let c1 = to_cstring(oligo1)?;
    let c2 = to_cstring(oligo2)?;

    let mut results: sys::thal_results = unsafe { std::mem::zeroed() };
    {
        let _guard = THAL_CALL_LOCK.lock().unwrap();
        unsafe {
            sys::thal(c1.as_ptr() as *const u8, c2.as_ptr() as *const u8, args, mode, &mut results, 0);
        }
    }

    // Matches primer3-py's actual ThermoResult exactly: `tm`/`dg` are the
    // raw thal_results values regardless of `structure_found` (a "no
    // structure" result still reports temp=0.0/dg=0.0, not an absent
    // value) - confirmed via a real primer3-py corpus, not assumed.
    let structure_found = results.no_structure == 0;
    let (tm, dg) = (Some(results.temp), Some(results.dg));

    if !results.sec_struct.is_null() {
        unsafe { free(results.sec_struct as *mut std::os::raw::c_void) };
    }

    Ok(ThermoResult { structure_found, tm, dg })
}

extern "C" {
    fn free(ptr: *mut std::os::raw::c_void);
}

/// `thal()` with `type=thal_hairpin`, `dimer=0` — intramolecular
/// (self-)folding, matching `primer3.bindings.calc_hairpin`.
pub fn calc_hairpin(seq: &str, mv_conc: f64, dv_conc: f64, dntp_conc: f64, dna_conc: f64) -> Result<ThermoResult, Primer3Error> {
    let args = make_thal_args(mv_conc, dv_conc, dntp_conc, dna_conc, sys::thal_alignment_type_thal_hairpin, false);
    run_thal(seq, seq, &args, sys::thal_mode_THL_GENERAL)
}

/// `thal()` with `type=thal_any`, `dimer=1`, `oligo1==oligo2` — matching
/// `primer3.bindings.calc_homodimer`.
pub fn calc_homodimer(seq: &str, mv_conc: f64, dv_conc: f64, dntp_conc: f64, dna_conc: f64) -> Result<ThermoResult, Primer3Error> {
    let args = make_thal_args(mv_conc, dv_conc, dntp_conc, dna_conc, sys::thal_alignment_type_thal_any, true);
    run_thal(seq, seq, &args, sys::thal_mode_THL_GENERAL)
}

/// `thal()` with `type=thal_any`, `dimer=1` — matching
/// `primer3.bindings.calc_heterodimer`.
pub fn calc_heterodimer(seq1: &str, seq2: &str, mv_conc: f64, dv_conc: f64, dntp_conc: f64, dna_conc: f64) -> Result<ThermoResult, Primer3Error> {
    let args = make_thal_args(mv_conc, dv_conc, dntp_conc, dna_conc, sys::thal_alignment_type_thal_any, true);
    run_thal(seq1, seq2, &args, sys::thal_mode_THL_GENERAL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calc_tm_returns_finite_plausible_value() {
        let tm = calc_tm("ACGTACGTACGTACGTACGT", 50.0, 1.5, 0.2, 50.0).unwrap();
        assert!(tm.is_finite());
        assert!((20.0..90.0).contains(&tm), "tm={tm}");
    }

    #[test]
    fn calc_hairpin_perfect_hairpin_finds_structure() {
        // A stem-loop: 8bp complementary arms around a tetraloop.
        let seq = "GCGCAAAAGCGC";
        let result = calc_hairpin(seq, 50.0, 1.5, 0.2, 50.0).unwrap();
        assert!(result.structure_found, "a perfect hairpin should be found");
        assert!(result.dg.unwrap() < 0.0, "a stable hairpin should have negative dG");
    }

    #[test]
    fn calc_homodimer_self_complementary_finds_structure() {
        let result = calc_homodimer("ACGTACGT", 50.0, 1.5, 0.2, 50.0).unwrap();
        assert!(result.structure_found);
    }

    #[test]
    fn calc_heterodimer_perfect_complement_finds_structure() {
        let result = calc_heterodimer("ACGTACGTACGT", "ACGTACGTACGT", 50.0, 1.5, 0.2, 50.0).unwrap();
        assert!(result.structure_found);
    }
}
