//! Compiles Primer3's C sources (thermodynamic primitives *and* the
//! picking engine) and generates bindgen bindings against curated header
//! subsets (`wrapper.h`, `wrapper_picker.h`).
//!
//! Vendored from **`libnano/primer3-py`** (pinned `v2.3.0`, matching the
//! version the current Flask app already depends on), not the upstream
//! `primer3-org/primer3` mirror — primer3-py's maintainers patched
//! `thal_results` to expose `dh`/`ds`/`dg`/`no_structure` directly (plain
//! `thal()` upstream only returns a melting temperature, not free energy),
//! reworked the picking engine for thread-safety (removed function-local
//! `static` mutable state), and compiled it as plain C instead of C++
//! (`libprimer3.cc` upstream vs. `libprimer3flex.c` here) — all of which
//! make this fork a meaningfully better FFI target than upstream.
//!
//! Source file list for the picking engine mirrors primer3-py's own
//! `setup.py::LIBPRIMER3_C_FPS_FLEX` exactly (the proven, actually-linked
//! set backing the real `thermoanalysis` extension), not a guess:
//! `dpal.c`, `libprimer3flex.c`, `oligotm.c`, `p3_seq_lib.c`,
//! `read_boulder.c`, `thalflex.c`, `thal_parameters.c`, `masker.c`
//! (non-Windows). Default thermodynamic parameters are embedded C string
//! literals (`set_default_thal_parameters`) parsed once at runtime via
//! `get_thermodynamic_values` (into process-global static tables shared by
//! both `thal()` and `choose_primers()` — confirmed by reading
//! `libprimer3flex.c`, which never calls `get_thermodynamic_values`
//! itself), so no `primer3_config/*.dh`/`*.ds` files need to ship
//! alongside the binary.

use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor_dir = manifest_dir.join("../../vendor/primer3-py/primer3/src/libprimer3");
    let klib_dir = vendor_dir.join("klib");

    for f in ["thalflex.c", "thal.h", "thal_parameters.c", "thal_parameters.h", "oligotm.c", "oligotm.h", "libprimer3flex.c", "libprimer3.h", "dpal.c", "dpal.h", "p3_seq_lib.c", "p3_seq_lib.h", "read_boulder.c", "masker.c", "masker.h"] {
        println!("cargo:rerun-if-changed={}", vendor_dir.join(f).display());
    }
    println!("cargo:rerun-if-changed=wrapper.h");

    cc::Build::new()
        .file(vendor_dir.join("thalflex.c"))
        .file(vendor_dir.join("thal_parameters.c"))
        .file(vendor_dir.join("oligotm.c"))
        .file(vendor_dir.join("dpal.c"))
        .file(vendor_dir.join("p3_seq_lib.c"))
        .file(vendor_dir.join("read_boulder.c"))
        .file(vendor_dir.join("masker.c"))
        .file(vendor_dir.join("libprimer3flex.c"))
        .include(&vendor_dir)
        .include(&klib_dir)
        .warnings(false)
        .flag_if_supported("-Wno-unused-but-set-variable")
        .flag_if_supported("-Wno-unused-variable")
        .flag_if_supported("-Wno-unused-function")
        .flag_if_supported("-Wno-implicit-function-declaration")
        .flag_if_supported("-Wno-int-conversion")
        .compile("primer3_full");

    let bindings = bindgen::Builder::default()
        .header("wrapper.h")
        .clang_arg(format!("-I{}", vendor_dir.display()))
        .clang_arg(format!("-I{}", klib_dir.display()))
        // Thermodynamic primitives (Phase 3).
        .allowlist_function("thal")
        .allowlist_function("set_thal_default_args")
        .allowlist_function("set_thal_oligo_default_args")
        .allowlist_function("thal_set_null_parameters")
        .allowlist_function("thal_load_parameters")
        .allowlist_function("thal_free_parameters")
        .allowlist_function("get_thermodynamic_values")
        .allowlist_function("destroy_thal_structures")
        .allowlist_function("set_default_thal_parameters")
        .allowlist_function("oligotm")
        .allowlist_function("seqtm")
        .allowlist_function("long_seq_tm")
        .allowlist_function("oligodg")
        .allowlist_function("end_oligodg")
        .allowlist_function("symmetry")
        .allowlist_function("divalent_to_monovalent")
        .allowlist_type("thal_.*")
        .allowlist_type("tm_ret")
        .allowlist_type("tm_method_type")
        .allowlist_type("salt_correction_type")
        // Picking engine (this phase): global settings + seq args
        // lifecycle, the setters Primerool's design modules actually use,
        // choose_primers itself, and result-reading accessors.
        .allowlist_function("p3_create_global_settings")
        .allowlist_function("p3_destroy_global_settings")
        .allowlist_function("p3_empty_gs_product_size_range")
        .allowlist_function("p3_add_to_gs_product_size_range")
        .allowlist_function("p3_set_gs_primer_.*")
        .allowlist_function("p3_set_gs_num_return")
        .allowlist_function("p3_set_gs_max_end_gc")
        .allowlist_function("create_seq_arg")
        .allowlist_function("destroy_seq_args")
        .allowlist_function("p3_set_sa_sequence")
        .allowlist_function("p3_set_sa_sequence_name")
        .allowlist_function("p3_set_sa_left_input")
        .allowlist_function("p3_set_sa_right_input")
        .allowlist_function("p3_set_sa_internal_input")
        .allowlist_function("p3_add_to_sa_tar2")
        .allowlist_function("p3_add_to_sa_excl2")
        .allowlist_function("p3_add_to_sa_excl_internal2")
        .allowlist_function("p3_add_to_sa_ok_regions")
        .allowlist_function("p3_set_sa_incl_s")
        .allowlist_function("p3_set_sa_incl_l")
        .allowlist_function("choose_primers")
        .allowlist_function("destroy_p3retval")
        .allowlist_function("destroy_secundary_structures")
        .allowlist_function("pr_oligo_sequence")
        .allowlist_function("pr_oligo_rev_c_sequence")
        // Real Primer3 explain-string formatters (the exact functions
        // primer3-py itself calls to build PRIMER_LEFT_EXPLAIN/
        // PRIMER_RIGHT_EXPLAIN/PRIMER_PAIR_EXPLAIN) - declared in the
        // header and implemented, unlike the four dead functions noted
        // above. Used instead of hand-rolling an equivalent formatter.
        .allowlist_function("p3_get_oligo_array_explain_string")
        .allowlist_function("p3_get_pair_array_explain_string")
        // NOTE: p3_get_oa_n / p3_get_oa_i / p3_set_gs_primer_explain_flag /
        // p3_set_gs_num_return are declared in libprimer3.h but have NO
        // implementation anywhere in this vendored source tree (confirmed
        // by grep - not just unused, genuinely absent) - do not allowlist
        // or call them, it's a link error every time. `oligo_array`'s
        // fields are read directly instead (see primer3-ffi/src/design.rs).
        .allowlist_function("p3_ol_is_ok")
        .allowlist_type("p3_global_settings")
        .allowlist_type("seq_args_t")
        .allowlist_type("p3retval")
        .allowlist_type("primer_rec")
        .allowlist_type("primer_pair")
        .allowlist_type("pair_array_t")
        .allowlist_type("oligo_array")
        .allowlist_type("pr_append_str")
        .allowlist_type("seq_lib")
        .opaque_type("seq_lib") // internal repeat-library type; never populated, never inspected
        .allowlist_type("masker_parameters")
        .opaque_type("masker_parameters") // internal masking config; never populated, never inspected
        .generate()
        .expect("bindgen failed to generate primer3 bindings");

    let out_path = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    bindings.write_to_file(out_path.join("bindings.rs")).expect("failed to write bindgen output");
}
