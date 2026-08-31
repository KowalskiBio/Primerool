//! Live integration test against the real Ensembl REST API.
//!
//! `#[ignore]`d by default — Ensembl's REST API was observed to be
//! genuinely degraded (500s on most gene symbols) during Phase 0's
//! golden-fixture capture; BRCA1 was the one gene that resolved reliably
//! at that time, so it's used here too. Run explicitly with:
//!
//!     cargo test -p providers --test live_ensembl -- --ignored --test-threads=1

use providers::{Feature, SequenceProvider, Strand};

#[tokio::test]
#[ignore = "hits live Ensembl REST API; run explicitly"]
async fn brca1_search_and_get_sequence() {
    let provider = providers::ensembl::EnsemblProvider::new();

    let gene = provider.search_gene("BRCA1", "homo_sapiens").await.unwrap().expect("BRCA1 should resolve on Ensembl");
    assert_eq!(gene.strand, Strand::Minus, "BRCA1 is minus-strand");
    assert!(!gene.transcripts.is_empty());

    let canonical = gene.transcripts.iter().find(|t| t.is_canonical).expect("a canonical transcript must be marked");
    let tinfo = provider.get_transcript_details(&canonical.id).await.unwrap().expect("transcript details must resolve");
    assert!(!tinfo.exons.is_empty());

    // Ensembl's /sequence/* endpoints have been observed genuinely down
    // (HTTP 500) independently of /lookup/* during this rewrite (see
    // scripts/golden/capture.py's docstring) - build_spliced_sequence
    // correctly returns None on that blanket HTTPError, matching Python's
    // `except requests.HTTPError: return None`. Don't hard-fail the test
    // on real upstream unavailability; only assert when data comes back.
    match provider.build_spliced_sequence(&tinfo, Feature::Exons, "homo_sapiens").await.unwrap() {
        Some(spliced) => assert!(!spliced.is_empty()),
        None => eprintln!("NOTE: Ensembl /sequence/id returned no data (upstream degraded?) - skipping sequence assertions"),
    }
}
