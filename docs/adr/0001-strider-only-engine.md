# Strider is the only design engine; Primer3 is a test-only reference

Primerool used to pick primers with Primer3's C `choose_primers()` (via FFI) and let users toggle Tm/structure calculations between Primer3 and Strider. We made Strider (`thermo-core` + `engine::picker`) the only engine for both thermodynamics and candidate picking, so the app has one ranking model, no C code in the server build, and no dependency on Primer3's behaviour; IDT OligoAnalyzer stays available as an external cross-check. `primer3-sys`/`primer3-ffi` and the vendored source remain in the workspace only so parity/comparison tests can measure Strider against Primer3.

## Consequences

- The picker's filter thresholds (poly-X 5, Ns 0, hairpin/self-dimer/pair-dimer Tm ≤ 47 °C) copy Primer3's defaults so designs stay familiar, but the penalty is Strider's own weighted distance-from-optimum, so picks differ from Primer3's.
- `cargo build -p server` (and the VM deploy) no longer needs a C compiler; `cargo test --workspace` still does.
