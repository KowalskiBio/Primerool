//! Safe wrapper over Primer3's picking engine (`choose_primers`).
//!
//! Scoped to exactly what Primerool's design modules need: primer/probe
//! size, Tm, GC, salt/conc, product-size range, `SEQUENCE_TARGET`/
//! `SEQUENCE_INCLUDED_REGION`/`SEQUENCE_PRIMER_PAIR_OK_REGION_LIST`-style
//! region constraints, and reading back `best_pairs` plus the raw
//! left/right/internal oligo arrays. Not a general-purpose binding of
//! every one of primer3's ~150 settings — the ones this module doesn't
//! expose keep their `p3_create_global_settings()` defaults.
//!
//! **Memory/threading**: `pr_oligo_sequence` writes into a `static`
//! (non-thread-local) buffer inside `libprimer3flex.c` — confirmed by
//! reading the C source, not assumed — so every call in this module goes
//! through the same global `THAL_CALL_LOCK` mutex `lib.rs` already uses
//! for `thal()`/`oligotm()`. `GlobalSettings`/`SeqArgs`/`DesignResult`'s
//! `Drop` impls call the matching `p3_destroy_*`/`destroy_*` functions —
//! never leak the C-side allocations.

use std::ffi::{CStr, CString};

use primer3_sys as sys;

use crate::{ensure_initialized, Primer3Error, THAL_CALL_LOCK};

pub struct GlobalSettings(*mut sys::p3_global_settings);

// Safety: never accessed concurrently — every method call through this
// crate's public functions is serialized behind `THAL_CALL_LOCK`.
unsafe impl Send for GlobalSettings {}

impl GlobalSettings {
    /// `p3_create_global_settings()` plus a wide-open default product-size
    /// range (`[50, 100000]`) — Primerool's design modes always set their
    /// own range explicitly, but the library's own tiny out-of-the-box
    /// default (`[100, 300]`, primer3's own bundled default before any
    /// override) would silently reject correct call sites that forget to.
    pub fn new() -> Self {
        ensure_initialized();
        let raw = unsafe { sys::p3_create_global_settings() };
        assert!(!raw.is_null(), "p3_create_global_settings returned NULL (OOM)");
        let mut gs = Self(raw);
        gs.set_product_size_range(50, 100_000);
        gs
    }

    pub fn set_primer_size(&mut self, opt: i32, min: i32, max: i32) {
        unsafe {
            sys::p3_set_gs_primer_opt_size(self.0, opt);
            sys::p3_set_gs_primer_min_size(self.0, min);
            sys::p3_set_gs_primer_max_size(self.0, max);
        }
    }

    pub fn set_primer_tm(&mut self, opt: f64, min: f64, max: f64) {
        unsafe {
            sys::p3_set_gs_primer_opt_tm(self.0, opt);
            sys::p3_set_gs_primer_min_tm(self.0, min);
            sys::p3_set_gs_primer_max_tm(self.0, max);
        }
    }

    pub fn set_primer_gc(&mut self, min: f64, max: f64) {
        unsafe {
            sys::p3_set_gs_primer_min_gc(self.0, min);
            sys::p3_set_gs_primer_max_gc(self.0, max);
        }
    }

    pub fn set_salt_conc(&mut self, mv_conc: f64, dv_conc: f64, dntp_conc: f64, dna_conc: f64) {
        unsafe {
            sys::p3_set_gs_primer_salt_conc(self.0, mv_conc);
            sys::p3_set_gs_primer_divalent_conc(self.0, dv_conc);
            sys::p3_set_gs_primer_dntp_conc(self.0, dntp_conc);
            sys::p3_set_gs_primer_dna_conc(self.0, dna_conc);
        }
    }

    pub fn set_max_poly_x(&mut self, val: i32) {
        unsafe { sys::p3_set_gs_primer_max_poly_x(self.0, val) };
    }

    pub fn set_num_ns_accepted(&mut self, val: i32) {
        unsafe { sys::p3_set_gs_primer_num_ns_accepted(self.0, val) };
    }

    pub fn set_num_return(&mut self, n: i32) {
        // NOT `p3_set_gs_num_return` - that symbol is declared in
        // libprimer3.h but has no implementation in libprimer3flex.c
        // (confirmed by grepping the source); calling it would be a
        // link-time landmine. `p3_set_gs_primer_num_return` is the real,
        // implemented setter for the same `num_return` field.
        unsafe { sys::p3_set_gs_primer_num_return(self.0, n) };
    }

    pub fn set_pick_primers(&mut self, left: bool, right: bool) {
        unsafe {
            sys::p3_set_gs_primer_pick_left_primer(self.0, left as i32);
            sys::p3_set_gs_primer_pick_right_primer(self.0, right as i32);
        }
    }

    pub fn set_pick_internal_oligo(&mut self, val: bool) {
        unsafe { sys::p3_set_gs_primer_pick_internal_oligo(self.0, val as i32) };
    }

    pub fn set_internal_oligo_size(&mut self, opt: i32, min: i32, max: i32) {
        unsafe {
            sys::p3_set_gs_primer_internal_oligo_opt_size(self.0, opt);
            sys::p3_set_gs_primer_internal_oligo_min_size(self.0, min);
            sys::p3_set_gs_primer_internal_oligo_max_size(self.0, max);
        }
    }

    pub fn set_internal_oligo_tm(&mut self, opt: f64, min: f64, max: f64) {
        unsafe {
            sys::p3_set_gs_primer_internal_oligo_opt_tm(self.0, opt);
            sys::p3_set_gs_primer_internal_oligo_min_tm(self.0, min);
            sys::p3_set_gs_primer_internal_oligo_max_tm(self.0, max);
        }
    }

    pub fn set_internal_oligo_gc(&mut self, min: f64, max: f64) {
        unsafe {
            sys::p3_set_gs_primer_internal_oligo_min_gc(self.0, min);
            sys::p3_set_gs_primer_internal_oligo_max_gc(self.0, max);
        }
    }

    pub fn set_internal_oligo_salt_conc(&mut self, mv_conc: f64, dv_conc: f64, dntp_conc: f64, dna_conc: f64) {
        unsafe {
            sys::p3_set_gs_primer_internal_oligo_salt_conc(self.0, mv_conc);
            sys::p3_set_gs_primer_internal_oligo_divalent_conc(self.0, dv_conc);
            sys::p3_set_gs_primer_internal_oligo_dntp_conc(self.0, dntp_conc);
            sys::p3_set_gs_primer_internal_oligo_dna_conc(self.0, dna_conc);
        }
    }

    pub fn set_product_size_range(&mut self, min: i32, max: i32) {
        unsafe {
            sys::p3_empty_gs_product_size_range(self.0);
            sys::p3_add_to_gs_product_size_range(self.0, min, max);
        }
    }

    // No `set_explain_flag`: `p3_set_gs_primer_explain_flag` and the
    // `explain_flag` field it would set are declared in libprimer3.h but
    // absent from both this fork's `p3_global_settings` struct and its
    // implementation - genuinely unavailable via this C API, not an
    // oversight. Per-sequence diagnostics still come through via
    // `p3retval.glob_err`/`per_sequence_err`/`warnings`
    // (`DesignResult::explain`).
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for GlobalSettings {
    fn drop(&mut self) {
        unsafe { sys::p3_destroy_global_settings(self.0) };
    }
}

pub struct SeqArgs(*mut sys::seq_args_t);
unsafe impl Send for SeqArgs {}

impl SeqArgs {
    pub fn new(template: &str) -> Result<Self, Primer3Error> {
        let raw = unsafe { sys::create_seq_arg() };
        assert!(!raw.is_null(), "create_seq_arg returned NULL (OOM)");
        let c = CString::new(template).map_err(|_| Primer3Error::InteriorNul)?;
        unsafe { sys::p3_set_sa_sequence(raw, c.as_ptr()) };
        Ok(Self(raw))
    }

    /// `SEQUENCE_TARGET`: primers must flank this region.
    pub fn add_target(&mut self, start: i32, len: i32) {
        unsafe { sys::p3_add_to_sa_tar2(self.0, start, len) };
    }

    /// `SEQUENCE_INCLUDED_REGION`: restrict candidate search to this
    /// sub-region (distinct semantics from `add_target` — this narrows
    /// *where* primers may be picked from, not what they must span).
    pub fn set_included_region(&mut self, start: i32, len: i32) {
        unsafe {
            sys::p3_set_sa_incl_s(self.0, start);
            sys::p3_set_sa_incl_l(self.0, len);
        }
    }

    /// `SEQUENCE_PRIMER_PAIR_OK_REGION_LIST`: pin the left/right primer to
    /// specific regions (`-1, -1` for "anywhere" on either side, matching
    /// Primer3's own convention).
    pub fn add_ok_region(&mut self, left_start: i32, left_len: i32, right_start: i32, right_len: i32) {
        unsafe { sys::p3_add_to_sa_ok_regions(self.0, left_start, left_len, right_start, right_len) };
    }
}

impl Drop for SeqArgs {
    fn drop(&mut self) {
        unsafe { sys::destroy_seq_args(self.0) };
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DesignedOligo {
    /// The actual synthesizable oligo sequence — already reverse-complemented
    /// for right primers (see `extract_oligo`'s docs on why this matters).
    pub sequence: String,
    /// 0-based, ascending, end-exclusive interval into the *forward
    /// strand* of the template, regardless of which primer this is.
    /// Primer3's own C convention represents a right primer as
    /// `(right_end, length)` where `right_end` is its 3'-most forward-
    /// strand position — normalized to a plain `[start, end)` here, once,
    /// rather than leaving three separate call sites (as the current
    /// Python app has) to each re-derive `start = right_end - length + 1`.
    pub start: i32,
    pub end: i32,
    pub tm: f64,
    pub gc_percent: f64,
    pub self_any: f64,
    pub self_end: f64,
    pub hairpin_th: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DesignedPair {
    pub left: DesignedOligo,
    pub right: DesignedOligo,
    pub product_size: i32,
    pub pair_quality: f64,
    pub compl_any: f64,
    pub compl_end: f64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct DesignResult {
    pub pairs: Vec<DesignedPair>,
    pub left_candidates: Vec<DesignedOligo>,
    pub right_candidates: Vec<DesignedOligo>,
    pub internal_candidates: Vec<DesignedOligo>,
    /// Real `PRIMER_LEFT_EXPLAIN`/`PRIMER_RIGHT_EXPLAIN`/
    /// `PRIMER_INTERNAL_OLIGO_EXPLAIN`/`PRIMER_PAIR_EXPLAIN` text, built by
    /// calling primer3's own `p3_get_oligo_array_explain_string`/
    /// `p3_get_pair_array_explain_string` (the exact functions primer3-py
    /// itself calls) rather than a hand-rolled reimplementation.
    pub left_explain: Option<String>,
    pub right_explain: Option<String>,
    pub internal_explain: Option<String>,
    pub pair_explain: Option<String>,
    /// `p3retval`'s global per-sequence error/warning string, when present
    /// (distinct from the per-array explain strings above).
    pub explain: Option<String>,
}

fn read_pr_append_str(s: &sys::pr_append_str) -> Option<String> {
    if s.data.is_null() {
        None
    } else {
        let cstr = unsafe { CStr::from_ptr(s.data) };
        let text = cstr.to_string_lossy().into_owned();
        if text.is_empty() { None } else { Some(text) }
    }
}

/// Copies out primer3's own oligo/pair-array explain string. Both
/// formatter functions write into a `static` buffer (same pattern as
/// `pr_oligo_sequence`), so callers must already hold `THAL_CALL_LOCK` and
/// copy the text out before releasing it.
fn read_oligo_explain(arr: &sys::oligo_array) -> Option<String> {
    let ptr = unsafe { sys::p3_get_oligo_array_explain_string(arr) };
    if ptr.is_null() {
        return None;
    }
    let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
    if text.is_empty() { None } else { Some(text) }
}

fn read_pair_explain(arr: &sys::pair_array_t) -> Option<String> {
    let ptr = unsafe { sys::p3_get_pair_array_explain_string(arr) };
    if ptr.is_null() {
        return None;
    }
    let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
    if text.is_empty() { None } else { Some(text) }
}

/// `is_right`: right primers need `pr_oligo_rev_c_sequence` (reverse-
/// complement of `[right_end-length+1, right_end+1)`), not
/// `pr_oligo_sequence` (a plain forward-strand substring) — confirmed by
/// reading both functions' C implementations directly: `pr_oligo_sequence`
/// does no strand handling at all, it's `pr_oligo_rev_c_sequence` that
/// computes the reverse-complement. Calling the wrong one for a right
/// primer silently returns the *forward-strand* bases under its 3' end
/// instead of the real, synthesizable primer sequence — caught only by
/// cross-checking against real `primer3.bindings.design_primers()` output
/// for the same input (the left primer matched exactly; the right one's
/// sequence text didn't, despite matching Tm/GC/product-size).
///
/// `primer_rec.start` is *always* relative to `seq_args_t.incl_s` (the
/// `SEQUENCE_INCLUDED_REGION` start, `0` when unset) — confirmed by reading
/// `pr_oligo_sequence`/`pr_oligo_rev_c_sequence` themselves, both of which
/// add `sa->incl_s` back before indexing into `sa->sequence`. This was
/// invisible in every design mode exercised so far (`SEQUENCE_TARGET`,
/// `SEQUENCE_PRIMER_PAIR_OK_REGION_LIST`, plain probe mode) because none of
/// them set a non-zero included-region start; caught only once
/// `design_flanking`'s `SEQUENCE_INCLUDED_REGION` windowing exercised this
/// path for the first time, via a coordinate-sanity test, not a sequence
/// mismatch (the *sequence text* was already correct — these two C
/// functions apply the offset internally — only this crate's separately
/// reported `start`/`end` fields were off by `incl_s`).
fn extract_oligo(sa: &SeqArgs, rec: &sys::primer_rec, is_right: bool) -> DesignedOligo {
    // Both accessors write into a shared `static` C buffer (see module
    // docs) - copy out immediately, never hold the pointer past this call.
    let seq_ptr = if is_right { unsafe { sys::pr_oligo_rev_c_sequence(sa.0, rec) } } else { unsafe { sys::pr_oligo_sequence(sa.0, rec) } };
    let sequence = if seq_ptr.is_null() { String::new() } else { unsafe { CStr::from_ptr(seq_ptr) }.to_string_lossy().into_owned() };

    let incl_s = unsafe { (*sa.0).incl_s };
    let (start, end) = if is_right { (incl_s + rec.start - rec.length as i32 + 1, incl_s + rec.start + 1) } else { (incl_s + rec.start, incl_s + rec.start + rec.length as i32) };

    DesignedOligo {
        sequence,
        start,
        end,
        tm: rec.temp,
        gc_percent: rec.gc_content,
        self_any: rec.self_any,
        self_end: rec.self_end,
        hairpin_th: rec.hairpin_th,
    }
}

/// `oligo_problems.prob` bits, ported from `libprimer3flex.c`'s local
/// `#define OP_*` constants (private to that .c file — not exposed via
/// any header, so bindgen can't see them; hardcoded here from reading the
/// source directly, values confirmed against the file's own `1UL << N`
/// definitions). Only the two "bookkeeping" bits matter for filtering:
/// every other bit records a *specific* constraint failure (low Tm, wrong
/// GC, not in an ok-region, high hairpin, etc).
const OP_PARTIALLY_WRITTEN: u64 = 1 << 0;
const OP_COMPLETELY_WRITTEN: u64 = 1 << 1;

/// `p3_get_oa_n`/`p3_get_oa_i` (the header-declared accessors) have no
/// implementation anywhere in this vendored source (confirmed by grep,
/// not just unused) — `oligo_array`'s layout is known exactly from
/// bindgen, so its `num_elem`/`oligo` fields are read directly instead.
///
/// `oligo_array` holds *every considered* candidate, not just the ones
/// that passed every constraint — Primer3 keeps rejected oligos around
/// (with `primer_rec.problems.prob` bitmask recording exactly why) for
/// its own EXPLAIN diagnostics. A real bug caught by parity testing:
/// `p3_ol_is_ok` (the one header-declared "is this ok" accessor that *is*
/// implemented) only checks the `OP_COMPLETELY_WRITTEN` bookkeeping bit —
/// "this record's computation finished" — not "this oligo has no
/// constraint failures", so using it as a pass/fail filter let through
/// ~40 candidates for a region real Primer3 only found 3 valid oligos in.
/// The correct check is "no problem bits set other than the two
/// bookkeeping ones".
///
/// `num_return` caps the result the same way primer3-py's own Cython
/// output layer does (`thermoanalysis.pyx`'s `pdh_design_output_to_dict`:
/// `print_fwd = min(num_return, num_fwd)` etc.) — confirmed by reading that
/// source directly, since the vendored C library's own header comment
/// ("the number of best primer pairs to return") doesn't make clear that
/// it *also* bounds single-oligo (non-paired) array output, not just
/// `best_pairs`. `oligo_array` is already sorted best-first by
/// `choose_primers` itself (confirmed against real `primer3-py` output:
/// the first N records here matched primer3-py's first N `PRIMER_LEFT_i`
/// entries exactly, position-for-position), so truncating to the first
/// `num_return` *after* the constraint filter above — not before — is the
/// correct order of operations.
fn extract_oligo_array(sa: &SeqArgs, arr: &sys::oligo_array, num_return: i32) -> Vec<DesignedOligo> {
    if arr.oligo.is_null() || arr.num_elem <= 0 {
        return Vec::new();
    }
    let is_right = arr.type_ == sys::oligo_type_OT_RIGHT;
    let oligos: Vec<DesignedOligo> = (0..arr.num_elem)
        .filter_map(|i| {
            let rec = unsafe { &*arr.oligo.offset(i as isize) };
            let prob = rec.problems.prob;
            if prob & !(OP_PARTIALLY_WRITTEN | OP_COMPLETELY_WRITTEN) != 0 {
                return None;
            }
            Some(extract_oligo(sa, rec, is_right))
        })
        .collect();
    let cap = num_return.max(0) as usize;
    if oligos.len() > cap {
        oligos.into_iter().take(cap).collect()
    } else {
        oligos
    }
}

/// Runs `choose_primers` and extracts the results. `sa` is `&mut` because
/// `choose_primers` takes `seq_args_t*` (not `const*`) — it mutates
/// derived fields (trimmed sequence, quality arrays) in place.
///
/// The whole call — `choose_primers` *and* every extraction step that
/// follows — runs under one `THAL_CALL_LOCK` acquisition, not just the
/// `choose_primers` call itself: `extract_oligo`'s `pr_oligo_sequence`/
/// `pr_oligo_rev_c_sequence` calls and the explain-string formatters below
/// all write into the same `static` buffers `thal()`/`oligotm()` do, so
/// narrowing the guard to just `choose_primers` (an earlier version of this
/// function did) would leave those reads racing against a concurrent
/// caller's `choose_primers`/`thal` call.
pub fn design_primers(gs: &GlobalSettings, sa: &mut SeqArgs) -> Result<DesignResult, Primer3Error> {
    ensure_initialized();
    let _guard = THAL_CALL_LOCK.lock().unwrap();

    let num_return = unsafe { (*gs.0).num_return };
    let retval = unsafe { sys::choose_primers(gs.0, sa.0) };

    if retval.is_null() {
        return Err(Primer3Error::CallFailed("choose_primers returned NULL (OOM)".to_string()));
    }

    // SAFETY: retval is non-null and owned by this call until destroy_p3retval.
    let result = unsafe {
        let r = &*retval;
        let glob_err = read_pr_append_str(&r.glob_err);
        if let Some(err) = &glob_err {
            sys::destroy_p3retval(retval);
            return Err(Primer3Error::CallFailed(err.clone()));
        }

        let explain = read_pr_append_str(&r.per_sequence_err).or_else(|| read_pr_append_str(&r.warnings));
        let left_explain = read_oligo_explain(&r.fwd);
        let right_explain = read_oligo_explain(&r.rev);
        let internal_explain = read_oligo_explain(&r.intl);
        let pair_explain = read_pair_explain(&r.best_pairs);

        let mut pairs = Vec::with_capacity(r.best_pairs.num_pairs.max(0) as usize);
        for i in 0..r.best_pairs.num_pairs {
            let pp = &*r.best_pairs.pairs.offset(i as isize);
            if pp.left.is_null() || pp.right.is_null() {
                continue;
            }
            pairs.push(DesignedPair {
                left: extract_oligo(sa, &*pp.left, false),
                right: extract_oligo(sa, &*pp.right, true),
                product_size: pp.product_size,
                pair_quality: pp.pair_quality,
                compl_any: pp.compl_any,
                compl_end: pp.compl_end,
            });
        }

        DesignResult {
            pairs,
            left_candidates: extract_oligo_array(sa, &r.fwd, num_return),
            right_candidates: extract_oligo_array(sa, &r.rev, num_return),
            internal_candidates: extract_oligo_array(sa, &r.intl, num_return),
            left_explain,
            right_explain,
            internal_explain,
            pair_explain,
            explain,
        }
    };

    unsafe { sys::destroy_p3retval(retval) };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_drop_many_times_does_not_crash() {
        // Exercises GlobalSettings/SeqArgs's Drop impls repeatedly - a
        // real regression check for the destroy_* calls being correctly
        // wired (a missing/wrong destroy call here is a leak or a
        // double-free, not a wrong-answer, so this needs its own test
        // rather than relying on the parity tests to catch it).
        for _ in 0..20 {
            let gs = GlobalSettings::new();
            let mut sa = SeqArgs::new("ACGTACGTACGTACGTACGTACGTACGTACGT").unwrap();
            let _ = design_primers(&gs, &mut sa);
        }
    }

    #[test]
    fn design_primers_on_too_short_template_reports_zero_pairs_not_a_crash() {
        let gs = GlobalSettings::new();
        let mut sa = SeqArgs::new("ACGT").unwrap();
        let result = design_primers(&gs, &mut sa).unwrap();
        assert!(result.pairs.is_empty());
    }

    #[test]
    fn seq_args_rejects_interior_nul() {
        assert!(matches!(SeqArgs::new("ACG\0T"), Err(Primer3Error::InteriorNul)));
    }
}
