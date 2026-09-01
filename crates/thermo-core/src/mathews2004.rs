//! Mathews 2004 DNA parameter set (ΔG₃₇ + ΔH), embedded from Oligool's
//! actual dependency — the `strider` fork `KowalskiBio/strider@mathews2004-dangles`,
//! file `strider/thermo/parameters/mathews2004-dna.json` — so that
//! [`crate::structure_thermo`]'s hairpin/dimer structure Tm matches
//! Oligool's default `parameter_set="mathews2004-dna"` numbers exactly,
//! rather than approximating them.
//!
//! **Fidelity note** (load-bearing, do not "fix"): strider's
//! `lookup_table(name, fallback)` does `override.dG.get(name, fallback)` —
//! i.e. when a named sub-table is *absent* from this JSON's `dG`/`dH` object
//! entirely (not merely empty), the lookup falls back to the native
//! SantaLucia ΔG₃₇ table for that name, **regardless of whether a ΔG or ΔH
//! value was being computed** — both walks call the same
//! `_stack_energy`/`_hairpin_loop_energy`/`_interior_bulge_energy` helpers
//! with a hardcoded `parameters_dna.*` fallback constant. This bundled JSON
//! omits `interior_1_2` and `log_loop_penalty` (dH only) entirely, so those
//! specific lookups genuinely mix a ΔG₃₇ number into an otherwise-ΔH sum.
//! Replicated here via [`Mode`]-independent fallback to the same native
//! constants in [`crate::tables::dna`] for whichever table is missing.
//!
//! A table present in the JSON but *empty* (`hairpin_triloop`/
//! `hairpin_tetraloop`) is a different case: the override *is* consulted
//! (and always misses), so callers get the per-key default, never the
//! native table's values.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::tables::dna as native;
use crate::tables::{lookup, pack};

#[derive(Debug, Default, serde::Deserialize)]
struct RawSection {
    #[serde(default)]
    stack: Option<HashMap<String, f64>>,
    #[serde(default)]
    hairpin_size: Option<Vec<f64>>,
    #[serde(default)]
    bulge_size: Option<Vec<f64>>,
    #[serde(default)]
    interior_size: Option<Vec<f64>>,
    #[serde(default)]
    hairpin_mismatch: Option<HashMap<String, f64>>,
    #[serde(default)]
    interior_mismatch: Option<HashMap<String, f64>>,
    #[serde(default)]
    terminal_penalty: Option<HashMap<String, f64>>,
    #[serde(default)]
    dangle_3: Option<HashMap<String, f64>>,
    #[serde(default)]
    dangle_5: Option<HashMap<String, f64>>,
    #[serde(default)]
    interior_1_1: Option<HashMap<String, f64>>,
    #[serde(default)]
    interior_1_2: Option<HashMap<String, f64>>,
    #[serde(default)]
    interior_2_2: Option<HashMap<String, f64>>,
    #[serde(default)]
    hairpin_triloop: Option<HashMap<String, f64>>,
    #[serde(default)]
    hairpin_tetraloop: Option<HashMap<String, f64>>,
    #[serde(default)]
    asymmetry_ninio: Option<Vec<f64>>,
    #[serde(default)]
    log_loop_penalty: Option<f64>,
}

#[derive(Debug, serde::Deserialize)]
struct RawParamSet {
    #[serde(rename = "dG")]
    dg: RawSection,
    #[serde(rename = "dH")]
    dh: RawSection,
}

/// Which of the two co-derived sums (ΔG₃₇ or ΔH) a walk is currently
/// computing. Selects which JSON section is consulted — see the module
/// docs for why missing keys still fall back to the ΔG₃₇ native table in
/// *either* mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Dg,
    Dh,
}

pub struct Mathews2004Params {
    dg: RawSection,
    dh: RawSection,
}

static PARAMS: OnceLock<Mathews2004Params> = OnceLock::new();

/// The bundled Mathews 2004 DNA parameter set, parsed once.
pub fn params() -> &'static Mathews2004Params {
    PARAMS.get_or_init(|| {
        let raw: RawParamSet = serde_json::from_str(include_str!("../data/mathews2004-dna.json"))
            .expect("bundled mathews2004-dna.json must parse");
        Mathews2004Params { dg: raw.dg, dh: raw.dh }
    })
}

impl Mathews2004Params {
    fn section(&self, mode: Mode) -> &RawSection {
        match mode {
            Mode::Dg => &self.dg,
            Mode::Dh => &self.dh,
        }
    }

    /// `lookup_table(name, fallback).get(key, default)`: pick the override
    /// table (if the section defines it at all) or fall back wholesale to
    /// `native_lookup`, then apply `default` only on a miss in whichever
    /// table was chosen.
    fn dict_lookup(
        table: &Option<HashMap<String, f64>>,
        key: &str,
        default: f64,
        native_lookup: impl Fn(&str) -> Option<f64>,
    ) -> f64 {
        match table {
            Some(map) => map.get(key).copied().unwrap_or(default),
            None => native_lookup(key).unwrap_or(default),
        }
    }

    /// Same as `dict_lookup` but returns `None` on a miss instead of a
    /// default — for tables where "not found" must trigger a different
    /// code path (the small exact-interior-loop tables), not just add 0.
    fn dict_lookup_opt(
        table: &Option<HashMap<String, f64>>,
        key: &str,
        native_lookup: impl Fn(&str) -> Option<f64>,
    ) -> Option<f64> {
        match table {
            Some(map) => map.get(key).copied(),
            None => native_lookup(key),
        }
    }

    fn native_pack2(t: &'static [(u32, f64)]) -> impl Fn(&str) -> Option<f64> {
        move |key: &str| lookup(t, pack(key.as_bytes()))
    }

    /// Raw lookup, no default applied — callers in `structure_thermo` apply
    /// whichever default the corresponding Python call site uses (`_stack_energy`
    /// and `_interior_bulge_energy`'s single-base-bulge case both consult
    /// "stack" but with *different* defaults, -1.5 vs 0.0, so the default
    /// cannot be baked in here).
    pub fn stack(&self, mode: Mode, key: &str) -> Option<f64> {
        Self::dict_lookup_opt(&self.section(mode).stack, key, Self::native_pack2(native::STACK))
    }

    pub fn terminal_penalty(&self, mode: Mode, key: &str) -> f64 {
        Self::dict_lookup(&self.section(mode).terminal_penalty, key, 0.0, Self::native_pack2(native::TERMINAL_PENALTY))
    }

    pub fn hairpin_mismatch(&self, mode: Mode, key: &str) -> f64 {
        Self::dict_lookup(&self.section(mode).hairpin_mismatch, key, 0.0, Self::native_pack2(native::HAIRPIN_MISMATCH))
    }

    pub fn interior_mismatch(&self, mode: Mode, key: &str) -> f64 {
        Self::dict_lookup(&self.section(mode).interior_mismatch, key, 0.0, Self::native_pack2(native::INTERIOR_MISMATCH))
    }

    pub fn hairpin_triloop(&self, mode: Mode, key: &str) -> f64 {
        Self::dict_lookup(&self.section(mode).hairpin_triloop, key, 0.0, Self::native_pack2(native::HAIRPIN_TRILOOP))
    }

    pub fn hairpin_tetraloop(&self, mode: Mode, key: &str) -> f64 {
        Self::dict_lookup(&self.section(mode).hairpin_tetraloop, key, 0.0, Self::native_pack2(native::HAIRPIN_TETRALOOP))
    }

    /// `None` if this base pairing has no negative dangling-end stack (the
    /// caller only ever wants the value when it is negative).
    pub fn dangle_5(&self, mode: Mode, key: &str) -> Option<f64> {
        Self::dict_lookup_opt(&self.section(mode).dangle_5, key, Self::native_pack2(native::DANGLE_5))
    }

    pub fn dangle_3(&self, mode: Mode, key: &str) -> Option<f64> {
        Self::dict_lookup_opt(&self.section(mode).dangle_3, key, Self::native_pack2(native::DANGLE_3))
    }

    /// Exact small-interior-loop tables: `None` on a miss means "no exact
    /// entry", which callers must treat as a signal to fall through to the
    /// general interior-loop formula, not as zero energy.
    pub fn interior_1_1(&self, mode: Mode, key: &str) -> Option<f64> {
        Self::dict_lookup_opt(&self.section(mode).interior_1_1, key, Self::native_pack2(native::INTERIOR_1_1))
    }

    pub fn interior_1_2(&self, mode: Mode, key: &str) -> Option<f64> {
        Self::dict_lookup_opt(&self.section(mode).interior_1_2, key, Self::native_pack2(native::INTERIOR_1_2))
    }

    pub fn interior_2_2(&self, mode: Mode, key: &str) -> Option<f64> {
        Self::dict_lookup_opt(&self.section(mode).interior_2_2, key, Self::native_pack2(native::INTERIOR_2_2))
    }

    fn list_lookup(list: &Option<Vec<f64>>, idx: usize, native_list: &'static [f64]) -> f64 {
        let l = list.as_deref().unwrap_or(native_list);
        l[idx]
    }

    fn list_last(list: &Option<Vec<f64>>, native_list: &'static [f64]) -> f64 {
        let l = list.as_deref().unwrap_or(native_list);
        l[l.len() - 1]
    }

    pub fn hairpin_size(&self, mode: Mode, idx: usize) -> f64 {
        Self::list_lookup(&self.section(mode).hairpin_size, idx, native::HAIRPIN_SIZE)
    }
    pub fn hairpin_size_last(&self, mode: Mode) -> f64 {
        Self::list_last(&self.section(mode).hairpin_size, native::HAIRPIN_SIZE)
    }
    pub fn hairpin_size_len(&self, mode: Mode) -> usize {
        self.section(mode).hairpin_size.as_ref().map(|v| v.len()).unwrap_or(native::HAIRPIN_SIZE.len())
    }

    pub fn bulge_size(&self, mode: Mode, idx: usize) -> f64 {
        Self::list_lookup(&self.section(mode).bulge_size, idx, native::BULGE_SIZE)
    }
    pub fn bulge_size_last(&self, mode: Mode) -> f64 {
        Self::list_last(&self.section(mode).bulge_size, native::BULGE_SIZE)
    }

    pub fn interior_size(&self, mode: Mode, idx: usize) -> f64 {
        Self::list_lookup(&self.section(mode).interior_size, idx, native::INTERIOR_SIZE)
    }
    pub fn interior_size_last(&self, mode: Mode) -> f64 {
        Self::list_last(&self.section(mode).interior_size, native::INTERIOR_SIZE)
    }

    pub fn asymmetry_ninio(&self, mode: Mode, idx: usize) -> f64 {
        Self::list_lookup(&self.section(mode).asymmetry_ninio, idx, native::ASYMMETRY_NINIO)
    }

    pub fn log_loop_penalty(&self, mode: Mode) -> f64 {
        self.section(mode).log_loop_penalty.unwrap_or(native::LOG_LOOP_PENALTY)
    }
}
