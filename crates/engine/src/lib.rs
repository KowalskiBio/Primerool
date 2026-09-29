//! Strider primer/probe design engine.
//!
//! `ThermoBackend` covers the thermodynamic primitives (Tm, hairpin,
//! homodimer, heterodimer), implemented by `NativeBackend` over
//! `thermo-core`. `picker` is the single candidate scan/filter/score/rank
//! engine every `design_*` mode picks through. Primer3 is not a runtime
//! dependency; it only appears in this crate's integration tests as a
//! reference (`tests/common/primer3_backend.rs`).

pub mod analyze;
pub mod backend;
pub mod backend_native;
pub mod conserved;
pub mod defaults;
pub mod design_arms;
pub mod design_flanking;
pub mod design_from_sequence;
pub mod design_general;
pub mod design_internal;
pub mod design_junction;
pub mod design_probe;
pub mod picker;
pub mod structure_variant;

pub use backend::{DimerResult, ThermoBackend, ThermoParams};
