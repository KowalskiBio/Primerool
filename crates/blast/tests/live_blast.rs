//! Live integration test against NCBI's real BLAST service.
//!
//! `#[ignore]`d by default — this takes up to ~3 minutes and hits a live,
//! rate-limited third-party service. Run explicitly with:
//!
//!     cargo test -p blast --test live_blast -- --ignored --test-threads=1

#[tokio::test]
#[ignore = "hits live NCBI BLAST; takes up to ~3 minutes"]
async fn run_blast_on_a_tp53_fragment_returns_plausible_hits() {
    // A short fragment of human TP53 genomic sequence (same corpus used by
    // Phase 0's golden-fixture capture: scripts/golden/fixtures/
    // blast_sequence_tp53_fragment.json), so this is a real parity check
    // against the existing Flask app's actual BLAST behavior, not just
    // "does it not crash."
    let sequence = "CTCAAAAGTCTAGAGCCACCGTCCAGGGAGCAGGTAGCTGCTGGGCTCCGGGGACACTTTGCGTTCGGGCTGGGAGCGTGCTTTCCACGACGGTGACACGCTTCCCTGGATTGGCCAGACTGCCTTCCGGGTCACTGCCATGGAGGAGCCGCAGTCAGATCCTAGCGTCGAGCCCCCTCTGAGTCAGGAAACATTTTCAGACCTATGGAAACTACTTCCTGAAAACAACGTTCTGTCCCCCTTGCCGTCCCAAGCAATGGATGATTTGATGCTGTCCCCGGACGATATTGAACAATGGTT";
    let client = reqwest::Client::new();

    let hits = blast::run_blast(&client, sequence).await.expect("BLAST run should succeed");
    assert!(!hits.is_empty(), "a 400bp human TP53 fragment should return at least one hit against nt");

    let top = &hits[0];
    assert!(top.identity_pct > 90.0, "top hit for an exact human fragment should be high-identity, got {}", top.identity_pct);
    assert!(!top.accession.is_empty());
    assert_eq!(top.organism, "Homo sapiens");
    assert!(top.query_len > 0);
}
