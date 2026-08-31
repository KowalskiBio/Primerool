/** Ported verbatim from the legacy app's `speciesByKingdom` — the
 * kingdom/species picker's static data (values are Ensembl species names,
 * except `'__custom__'` which reveals the free-text species input). */

export interface SpeciesOption {
  label: string;
  value: string;
}

export type Kingdom = 'animals' | 'plants' | 'bacteria' | 'fungi' | 'protists' | 'viruses';

export const KINGDOM_LABELS: Record<Kingdom, string> = {
  animals: '🐾 Animals (Vertebrates)',
  plants: '🌱 Plants',
  bacteria: '🦠 Bacteria / Archaea',
  fungi: '🍄 Fungi',
  protists: '🔬 Protists',
  viruses: '🧬 Viruses',
};

export const SPECIES_BY_KINGDOM: Record<Kingdom, SpeciesOption[]> = {
  animals: [
    { label: 'Human (Homo sapiens)', value: 'homo_sapiens' },
    { label: 'Mouse (Mus musculus)', value: 'mus_musculus' },
    { label: 'Rat (Rattus norvegicus)', value: 'rattus_norvegicus' },
    { label: 'Zebrafish (Danio rerio)', value: 'danio_rerio' },
    { label: 'Chicken (Gallus gallus)', value: 'gallus_gallus' },
    { label: 'Pig (Sus scrofa)', value: 'sus_scrofa' },
    { label: 'Cow (Bos taurus)', value: 'bos_taurus' },
    { label: 'Dog (Canis lupus familiaris)', value: 'canis_lupus_familiaris' },
    { label: 'Cat (Felis catus)', value: 'felis_catus' },
    { label: 'Sheep (Ovis aries)', value: 'ovis_aries' },
    { label: 'Rabbit (Oryctolagus cuniculus)', value: 'oryctolagus_cuniculus' },
    { label: 'Macaque (Macaca mulatta)', value: 'macaca_mulatta' },
    { label: 'Chimpanzee (Pan troglodytes)', value: 'pan_troglodytes' },
    { label: 'Frog (Xenopus tropicalis)', value: 'xenopus_tropicalis' },
    { label: 'Fruit fly (Drosophila melanogaster)', value: 'drosophila_melanogaster' },
    { label: 'C. elegans', value: 'caenorhabditis_elegans' },
    { label: 'Custom...', value: '__custom__' },
  ],
  plants: [
    { label: 'Arabidopsis thaliana', value: 'arabidopsis_thaliana' },
    { label: 'Rice (Oryza sativa Japonica)', value: 'oryza_sativa' },
    { label: 'Maize (Zea mays)', value: 'zea_mays' },
    { label: 'Wheat (Triticum aestivum)', value: 'triticum_aestivum' },
    { label: 'Tomato (Solanum lycopersicum)', value: 'solanum_lycopersicum' },
    { label: 'Soybean (Glycine max)', value: 'glycine_max' },
    { label: 'Grape (Vitis vinifera)', value: 'vitis_vinifera' },
    { label: 'Potato (Solanum tuberosum)', value: 'solanum_tuberosum' },
    { label: 'Barley (Hordeum vulgare)', value: 'hordeum_vulgare' },
    { label: 'Tobacco (Nicotiana tabacum)', value: 'nicotiana_tabacum' },
    { label: 'Custom...', value: '__custom__' },
  ],
  bacteria: [
    { label: 'Escherichia coli K-12 MG1655', value: 'escherichia_coli_str_k_12_substr_mg1655_gca_000005845' },
    { label: 'Bacillus subtilis 168', value: 'bacillus_subtilis_subsp_subtilis_str_168_gca_000009045' },
    { label: 'Staphylococcus aureus NCTC 8325', value: 'staphylococcus_aureus_subsp_aureus_nctc_8325_gca_000013425' },
    { label: 'Pseudomonas aeruginosa PAO1', value: 'pseudomonas_aeruginosa_pao1_gca_000006765' },
    { label: 'Mycobacterium tuberculosis H37Ra', value: 'mycobacterium_tuberculosis_h37ra_gca_000016145' },
    { label: 'Salmonella enterica Typhimurium LT2', value: 'salmonella_enterica_subsp_enterica_serovar_typhimurium_str_lt2_gca_000006945' },
    { label: 'Streptococcus pneumoniae TIGR4', value: 'streptococcus_pneumoniae_tigr4_gca_000006885' },
    { label: 'Custom...', value: '__custom__' },
  ],
  fungi: [
    { label: "Saccharomyces cerevisiae (Baker's yeast)", value: 'saccharomyces_cerevisiae' },
    { label: 'Schizosaccharomyces pombe (Fission yeast)', value: 'schizosaccharomyces_pombe' },
    { label: 'Aspergillus nidulans', value: 'aspergillus_nidulans' },
    { label: 'Neurospora crassa', value: 'neurospora_crassa' },
    { label: 'Candida albicans', value: 'candida_albicans' },
    { label: 'Custom...', value: '__custom__' },
  ],
  protists: [
    { label: 'Plasmodium falciparum 3D7', value: 'plasmodium_falciparum' },
    { label: 'Trypanosoma brucei', value: 'trypanosoma_brucei' },
    { label: 'Leishmania major', value: 'leishmania_major' },
    { label: 'Dictyostelium discoideum', value: 'dictyostelium_discoideum' },
    { label: 'Toxoplasma gondii', value: 'toxoplasma_gondii_me49' },
    { label: 'Custom...', value: '__custom__' },
  ],
  viruses: [
    { label: 'SARS-CoV-2', value: 'sars_cov_2' },
    { label: 'Custom...', value: '__custom__' },
  ],
};

/** Reverse lookup used when a BLAST hit resolves to a species not
 * currently selected in the UI — finds which kingdom dropdown to switch
 * to, or falls back to "animals + custom" with the raw value filled in. */
export function findKingdomForSpecies(species: string): Kingdom | null {
  for (const kingdom of Object.keys(SPECIES_BY_KINGDOM) as Kingdom[]) {
    if (SPECIES_BY_KINGDOM[kingdom].some((s) => s.value === species)) return kingdom;
  }
  return null;
}
