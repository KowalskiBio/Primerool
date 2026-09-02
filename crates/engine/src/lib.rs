//! Dual-backend primer/probe design engine.
//!
//! `ThermoBackend` covers only thermodynamic primitives (Tm, hairpin,
//! homodimer, heterodimer) — implemented by `Primer3Backend` (FFI-backed,
//! Phase 3, complete) and `NativeBackend` (thermo-core-backed, Phase 5).
//! Candidate scanning/scoring/ranking (`picker`, Phase 5) is written once
//! and shared by both backends; it is what makes exhaustive-scan and
//! live-rescoring possible without redesign.
//!
//! **Phase 3 status**: `defaults`, `analyze`, `backend`, `backend_primer3`
//! are complete and validated (see `primer3-ffi`'s parity tests — 1,410
//! cases matching real `primer3-py` output to 1e-6). The `design_*`
//! modules (internal/flanking/junction/from_sequence/probe) are **not yet
//! implemented** — they all depend on Primer3's `choose_primers()` picking
//! engine, which is a separate, substantially larger FFI binding task than
//! the thermodynamic primitives (a ~250-field `p3_global_settings` struct,
//! `seq_args_t` construction, `pr_append_str` error/warning plumbing, and
//! `p3retval`/`primer_pair`/`primer_rec` result extraction). That engine
//! (`libprimer3flex.c` + `dpal.c` + `p3_seq_lib.c` + `read_boulder.c`, all
//! plain C, thread-safety-patched by primer3-py's maintainers) has been
//! confirmed bindable via the same vendored `primer3-py` v2.3.0 source
//! tree but is scoped as follow-up work, not attempted in this pass.
//!
//! Modules:
//! - `defaults`, `analyze`, `backend`, `backend_primer3`: done (Phase 3)
//! - `design_internal`, `design_flanking`, `design_junction`,
//!   `design_from_sequence`, `design_probe`: done, against `Primer3Backend`
//!   only — re-targeting onto `NativeBackend`/`engine::picker` for junction
//!   and internal candidate *generation* is still pending (their QC/
//!   analysis layer is already backend-generic; only `choose_primers`
//!   itself is Primer3-only for now)
//! - `backend_native`, `picker`: Phase 5
//! - `conserved`: Phase 7
//! - `design_arms`: SNP/indel ARMS-PCR allele-specific primer design — new
//!   feature, no Python original, against `Primer3Backend` only (see its
//!   own module docs for scope).

pub mod analyze;
pub mod backend;
pub mod backend_native;
pub mod backend_primer3;
pub mod conserved;
pub mod defaults;
pub mod design_arms;
pub mod design_flanking;
pub mod design_from_sequence;
pub mod design_internal;
pub mod design_junction;
pub mod design_probe;
pub mod picker;
pub mod structure_variant;

pub use backend::{DimerResult, ThermoBackend, ThermoParams};
