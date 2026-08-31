//! End-to-end parity test: `analyze_primer`/`analyze_pair` compared
//! against `backend/primer_utils.py`'s actual functions run against real
//! `primer3-py` (`tests/analyze_parity_corpus.json`) — validates the full
//! chain (defaults, backend call, 1-decimal rounding), not just the raw
//! FFI layer (that's `primer3-ffi/tests/parity.rs`'s job).

use engine::analyze::{analyze_pair, analyze_primer};
use engine::backend::ThermoParams;
use engine::backend_primer3::Primer3Backend;
use serde::Deserialize;

#[derive(Deserialize)]
struct DimerJson {
    structure_found: bool,
    tm: Option<f64>,
    dg: Option<f64>,
}

#[derive(Deserialize)]
struct PrimerCase {
    seq: String,
    gc_percent: f64,
    tm: f64,
    hairpin: DimerJson,
    homodimer: DimerJson,
}

#[derive(Deserialize)]
struct PairCase {
    fwd: String,
    rev: String,
    heterodimer: DimerJson,
}

#[derive(Deserialize)]
struct Corpus {
    primer: Vec<PrimerCase>,
    pair: Vec<PairCase>,
}

fn load_corpus() -> Corpus {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/analyze_parity_corpus.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn analyze_primer_matches_primer_utils_py() {
    let corpus = load_corpus();
    assert_eq!(corpus.primer.len(), 50);
    let backend = Primer3Backend;

    for case in &corpus.primer {
        let got = analyze_primer(&backend, &case.seq, ThermoParams::default());
        assert_eq!(got.gc_percent, Some(case.gc_percent), "gc_percent mismatch for {:?}", case.seq);
        assert_eq!(got.tm, Some(case.tm), "tm mismatch for {:?}", case.seq);
        assert_eq!(got.hairpin.structure_found, case.hairpin.structure_found);
        assert_eq!(got.hairpin.tm, case.hairpin.tm, "hairpin tm mismatch for {:?}", case.seq);
        assert_eq!(got.hairpin.dg, case.hairpin.dg, "hairpin dg mismatch for {:?}", case.seq);
        assert_eq!(got.homodimer.structure_found, case.homodimer.structure_found);
        assert_eq!(got.homodimer.tm, case.homodimer.tm, "homodimer tm mismatch for {:?}", case.seq);
        assert_eq!(got.homodimer.dg, case.homodimer.dg, "homodimer dg mismatch for {:?}", case.seq);
    }
}

#[test]
fn analyze_pair_matches_primer_utils_py() {
    let corpus = load_corpus();
    assert_eq!(corpus.pair.len(), 20);
    let backend = Primer3Backend;

    for case in &corpus.pair {
        let got = analyze_pair(&backend, &case.fwd, &case.rev, ThermoParams::default());
        assert_eq!(got.heterodimer.structure_found, case.heterodimer.structure_found);
        assert_eq!(got.heterodimer.tm, case.heterodimer.tm, "heterodimer tm mismatch for ({:?}, {:?})", case.fwd, case.rev);
        assert_eq!(got.heterodimer.dg, case.heterodimer.dg, "heterodimer dg mismatch for ({:?}, {:?})", case.fwd, case.rev);
    }
}
