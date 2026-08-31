//! Live integration tests against the real NCBI E-utilities API.
//!
//! `#[ignore]`d by default (network-dependent, rate-limited, and NCBI
//! itself can be degraded — see the golden-fixture capture notes in
//! `scripts/golden/capture.py`). Run explicitly with:
//!
//!     cargo test -p providers --test live_ncbi -- --ignored --test-threads=1
//!
//! Cross-checks against the same genes captured in Phase 0's golden
//! fixtures (`scripts/golden/fixtures/search_gene_ncbi_*.json`), so this is
//! real parity validation against the existing Flask app's actual output,
//! not just "does it not crash."

use providers::{Feature, SequenceProvider, Strand};

#[tokio::test]
#[ignore = "hits live NCBI E-utilities; run explicitly"]
async fn tp53_search_and_get_sequence_matches_golden_fixture_shape() {
    let provider = providers::ncbi::NcbiProvider::new();

    let gene = provider.search_gene("TP53", "homo_sapiens").await.unwrap().expect("TP53 should resolve on NCBI");
    assert_eq!(gene.strand, Strand::Minus, "TP53 is minus-strand, matching the golden fixture");
    assert!(!gene.transcripts.is_empty());

    let canonical = gene.transcripts.iter().find(|t| t.is_canonical).expect("a canonical transcript must be marked");
    assert!(canonical.id.starts_with("NM_"), "canonical should be an NM_ transcript when one exists");

    let tinfo = provider.get_transcript_details(&canonical.id).await.unwrap().expect("transcript details must be cached from search_gene");
    assert!(!tinfo.exons.is_empty());
    assert!(!tinfo.cds.is_empty(), "TP53's canonical transcript is protein-coding");

    let spliced = provider.build_spliced_sequence(&tinfo, Feature::Exons, "homo_sapiens").await.unwrap().expect("spliced sequence should be fetchable");
    assert_eq!(spliced.len(), tinfo.exons.iter().map(|(s, e)| e - s + 1).sum::<u64>() as usize);

    let (up, down) = provider.get_flanking_sequence(&tinfo, 200, 200, true, "homo_sapiens").await.unwrap();
    assert_eq!(up.len(), 200);
    assert_eq!(down.len(), 200);
}

#[tokio::test]
#[ignore = "hits live NCBI E-utilities; run explicitly"]
async fn dnaa_prokaryote_fallback_produces_single_exon_transcript() {
    let provider = providers::ncbi::NcbiProvider::new();

    let gene = provider.search_gene("dnaA", "escherichia_coli_str_k_12_substr_mg1655").await.unwrap().expect("dnaA should resolve on NCBI");
    assert_eq!(gene.transcripts.len(), 1, "prokaryote fallback synthesizes exactly one transcript");
    let t = &gene.transcripts[0];
    assert_eq!(t.id, "dnaA_CDS", "prokaryote fallback transcript id is '<gene>_CDS'");
    assert_eq!(t.exon_count, 1);

    let tinfo = provider.get_transcript_details(&t.id).await.unwrap().unwrap();
    assert_eq!(tinfo.exons, tinfo.cds, "synthetic prokaryote transcript treats the whole gene span as one exon = one CDS");
}

#[tokio::test]
#[ignore = "hits live NCBI E-utilities; run explicitly"]
async fn malat1_noncoding_transcript_has_no_cds() {
    let provider = providers::ncbi::NcbiProvider::new();

    let gene = provider.search_gene("MALAT1", "homo_sapiens").await.unwrap().expect("MALAT1 should resolve on NCBI");
    assert_eq!(gene.strand, Strand::Plus);

    // Every MALAT1 transcript is a non-coding ncRNA.
    for t in &gene.transcripts {
        let tinfo = provider.get_transcript_details(&t.id).await.unwrap().unwrap();
        assert!(tinfo.cds.is_empty(), "{} should have no CDS (MALAT1 is non-coding)", t.id);
    }
}
