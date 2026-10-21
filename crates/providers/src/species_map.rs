//! Ensembl-species-slug -> NCBI-binomial-name mapping, ported verbatim from
//! `ncbi_api.py::_SPECIES_MAP`. Drives NCBI `esearch` organism filters, so
//! the exact strings matter (not just the mapping's intent).

pub fn ensembl_to_binomial(species: &str) -> Option<&'static str> {
    ENSEMBL_TO_BINOMIAL
        .iter()
        .find(|(slug, _)| *slug == species)
        .map(|(_, name)| *name)
}

/// Falls back to `species.replace('_', ' ')` when not in the table, matching
/// `ncbi_api.py::search_gene`'s `_SPECIES_MAP.get(species, species.replace("_", " "))`.
pub fn ensembl_to_binomial_or_guess(species: &str) -> String {
    match ensembl_to_binomial(species) {
        Some(name) => name.to_string(),
        None => species.replace('_', " "),
    }
}

/// The NCBI E-utilities `[orgn]` filter for a species: a bare NCBI
/// Taxonomy ID (`294`, or `txid294`) becomes `txid294[orgn]`, which also
/// covers every taxon below it; anything else is resolved to a binomial
/// and quoted, so a multi-word name is always searched as one phrase.
pub fn ncbi_organism_term(species: &str) -> String {
    match taxid(species) {
        Some(id) => format!("txid{id}[orgn]"),
        None => format!("\"{}\"[orgn]", ensembl_to_binomial_or_guess(species.trim()).replace('"', "")),
    }
}

/// `294` or `txid294` (any case) -> `294`.
pub fn taxid(species: &str) -> Option<&str> {
    let s = species.trim();
    let digits = s.strip_prefix("txid").or_else(|| s.strip_prefix("TXID")).unwrap_or(s);
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

pub static ENSEMBL_TO_BINOMIAL: &[(&str, &str)] = &[
    // Animals / Vertebrates
    ("homo_sapiens", "Homo sapiens"),
    ("mus_musculus", "Mus musculus"),
    ("rattus_norvegicus", "Rattus norvegicus"),
    ("danio_rerio", "Danio rerio"),
    ("gallus_gallus", "Gallus gallus"),
    ("drosophila_melanogaster", "Drosophila melanogaster"),
    ("caenorhabditis_elegans", "Caenorhabditis elegans"),
    ("xenopus_tropicalis", "Xenopus tropicalis"),
    ("sus_scrofa", "Sus scrofa"),
    ("bos_taurus", "Bos taurus"),
    ("ovis_aries", "Ovis aries"),
    ("canis_lupus_familiaris", "Canis lupus familiaris"),
    ("felis_catus", "Felis catus"),
    ("macaca_mulatta", "Macaca mulatta"),
    ("pan_troglodytes", "Pan troglodytes"),
    ("oryctolagus_cuniculus", "Oryctolagus cuniculus"),
    // Fungi
    ("saccharomyces_cerevisiae", "Saccharomyces cerevisiae"),
    ("schizosaccharomyces_pombe", "Schizosaccharomyces pombe"),
    ("aspergillus_nidulans", "Aspergillus nidulans"),
    ("neurospora_crassa", "Neurospora crassa"),
    ("candida_albicans", "Candida albicans"),
    // Plants
    ("arabidopsis_thaliana", "Arabidopsis thaliana"),
    ("oryza_sativa", "Oryza sativa"),
    ("zea_mays", "Zea mays"),
    ("triticum_aestivum", "Triticum aestivum"),
    ("solanum_lycopersicum", "Solanum lycopersicum"),
    ("glycine_max", "Glycine max"),
    ("vitis_vinifera", "Vitis vinifera"),
    ("solanum_tuberosum", "Solanum tuberosum"),
    ("hordeum_vulgare", "Hordeum vulgare"),
    ("nicotiana_tabacum", "Nicotiana tabacum"),
    // Bacteria (Ensembl Bacteria requires GCA accession suffix)
    ("escherichia_coli_str_k_12_substr_mg1655_gca_000005845", "Escherichia coli"),
    ("bacillus_subtilis_subsp_subtilis_str_168_gca_000009045", "Bacillus subtilis"),
    ("staphylococcus_aureus_subsp_aureus_nctc_8325_gca_000013425", "Staphylococcus aureus"),
    ("pseudomonas_aeruginosa_pao1_gca_000006765", "Pseudomonas aeruginosa"),
    ("mycobacterium_tuberculosis_h37ra_gca_000016145", "Mycobacterium tuberculosis"),
    (
        "salmonella_enterica_subsp_enterica_serovar_typhimurium_str_lt2_gca_000006945",
        "Salmonella enterica",
    ),
    ("streptococcus_pneumoniae_tigr4_gca_000006885", "Streptococcus pneumoniae"),
    // Protists
    ("plasmodium_falciparum", "Plasmodium falciparum"),
    ("trypanosoma_brucei", "Trypanosoma brucei"),
    ("leishmania_major", "Leishmania major"),
    ("toxoplasma_gondii_me49", "Toxoplasma gondii"),
    ("dictyostelium_discoideum", "Dictyostelium discoideum"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_species_resolve() {
        assert_eq!(ensembl_to_binomial("homo_sapiens"), Some("Homo sapiens"));
        assert_eq!(
            ensembl_to_binomial("escherichia_coli_str_k_12_substr_mg1655_gca_000005845"),
            Some("Escherichia coli")
        );
    }

    #[test]
    fn unknown_species_falls_back_to_underscore_replace() {
        assert_eq!(ensembl_to_binomial_or_guess("my_custom_species"), "my custom species");
    }

    #[test]
    fn organism_term_takes_taxids_and_quotes_names() {
        assert_eq!(ncbi_organism_term("294"), "txid294[orgn]");
        assert_eq!(ncbi_organism_term(" txid286 "), "txid286[orgn]");
        assert_eq!(ncbi_organism_term("homo_sapiens"), "\"Homo sapiens\"[orgn]");
        assert_eq!(ncbi_organism_term("Pseudomonas fluorescens"), "\"Pseudomonas fluorescens\"[orgn]");
        assert_eq!(taxid("txid"), None);
        assert_eq!(taxid("9606a"), None);
    }

    #[test]
    fn table_matches_ncbi_api_py_entry_count() {
        // ncbi_api.py::_SPECIES_MAP has 43 entries (16 animals + 5 fungi +
        // 10 plants + 7 bacteria + 5 protists) - verified by parsing the
        // Python source directly during the port.
        assert_eq!(ENSEMBL_TO_BINOMIAL.len(), 43);
    }
}
