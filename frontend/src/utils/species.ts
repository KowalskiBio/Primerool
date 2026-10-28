/** Ported verbatim from the legacy app's `speciesByKingdom` — the
 * kingdom/species picker's static data (values are Ensembl species names,
 * except `'__custom__'` which reveals the free-text species input). */

export interface SpeciesRichLabel {
  /** Common name shown before the bracketed latin name — groups labelled by
   * their latin name only (bacteria/archaea, fungi, protists) omit it. */
  common?: string;
  /** Latin (scientific) name — rendered italic in the organism picker. */
  latin: string;
  /** Strain/serovar designation — upright, appended after the latin name. */
  strain?: string;
}

export interface SpeciesOption {
  label: string;
  value: string;
  rich?: SpeciesRichLabel;
}

export type Kingdom = 'animals' | 'plants' | 'bacteria' | 'fungi' | 'protists' | 'viruses';

export const KINGDOM_LABELS: Record<Kingdom, string> = {
  animals: '🐾 Animals',
  plants: '🌱 Plants',
  bacteria: '🦠 Bacteria / Archaea',
  fungi: '🍄 Fungi',
  protists: '🔬 Protists',
  viruses: '🧬 Viruses',
};

export const SPECIES_BY_KINGDOM: Record<Kingdom, SpeciesOption[]> = {
  animals: [
    { label: 'Human (Homo sapiens)', value: 'homo_sapiens', rich: { common: 'Human', latin: 'Homo sapiens' } },
    { label: 'Mouse (Mus musculus)', value: 'mus_musculus', rich: { common: 'Mouse', latin: 'Mus musculus' } },
    { label: 'Rat (Rattus norvegicus)', value: 'rattus_norvegicus', rich: { common: 'Rat', latin: 'Rattus norvegicus' } },
    { label: 'Zebrafish (Danio rerio)', value: 'danio_rerio', rich: { common: 'Zebrafish', latin: 'Danio rerio' } },
    { label: 'Chicken (Gallus gallus)', value: 'gallus_gallus', rich: { common: 'Chicken', latin: 'Gallus gallus' } },
    { label: 'Pig (Sus scrofa)', value: 'sus_scrofa', rich: { common: 'Pig', latin: 'Sus scrofa' } },
    { label: 'Cow (Bos taurus)', value: 'bos_taurus', rich: { common: 'Cow', latin: 'Bos taurus' } },
    { label: 'Dog (Canis lupus familiaris)', value: 'canis_lupus_familiaris', rich: { common: 'Dog', latin: 'Canis lupus familiaris' } },
    { label: 'Cat (Felis catus)', value: 'felis_catus', rich: { common: 'Cat', latin: 'Felis catus' } },
    { label: 'Sheep (Ovis aries)', value: 'ovis_aries', rich: { common: 'Sheep', latin: 'Ovis aries' } },
    { label: 'Rabbit (Oryctolagus cuniculus)', value: 'oryctolagus_cuniculus', rich: { common: 'Rabbit', latin: 'Oryctolagus cuniculus' } },
    { label: 'Macaque (Macaca mulatta)', value: 'macaca_mulatta', rich: { common: 'Macaque', latin: 'Macaca mulatta' } },
    { label: 'Chimpanzee (Pan troglodytes)', value: 'pan_troglodytes', rich: { common: 'Chimpanzee', latin: 'Pan troglodytes' } },
    { label: 'Frog (Xenopus tropicalis)', value: 'xenopus_tropicalis', rich: { common: 'Frog', latin: 'Xenopus tropicalis' } },
    { label: 'Fruit fly (Drosophila melanogaster)', value: 'drosophila_melanogaster', rich: { common: 'Fruit fly', latin: 'Drosophila melanogaster' } },
    { label: 'Caenorhabditis elegans', value: 'caenorhabditis_elegans', rich: { latin: 'Caenorhabditis elegans' } },
    { label: 'Custom...', value: '__custom__' },
  ],
  plants: [
    { label: 'Arabidopsis thaliana', value: 'arabidopsis_thaliana', rich: { latin: 'Arabidopsis thaliana' } },
    { label: 'Rice (Oryza sativa Japonica)', value: 'oryza_sativa', rich: { common: 'Rice', latin: 'Oryza sativa Japonica' } },
    { label: 'Maize (Zea mays)', value: 'zea_mays', rich: { common: 'Maize', latin: 'Zea mays' } },
    { label: 'Wheat (Triticum aestivum)', value: 'triticum_aestivum', rich: { common: 'Wheat', latin: 'Triticum aestivum' } },
    { label: 'Tomato (Solanum lycopersicum)', value: 'solanum_lycopersicum', rich: { common: 'Tomato', latin: 'Solanum lycopersicum' } },
    { label: 'Soybean (Glycine max)', value: 'glycine_max', rich: { common: 'Soybean', latin: 'Glycine max' } },
    { label: 'Grape (Vitis vinifera)', value: 'vitis_vinifera', rich: { common: 'Grape', latin: 'Vitis vinifera' } },
    { label: 'Potato (Solanum tuberosum)', value: 'solanum_tuberosum', rich: { common: 'Potato', latin: 'Solanum tuberosum' } },
    { label: 'Barley (Hordeum vulgare)', value: 'hordeum_vulgare', rich: { common: 'Barley', latin: 'Hordeum vulgare' } },
    { label: 'Tobacco (Nicotiana tabacum)', value: 'nicotiana_tabacum', rich: { common: 'Tobacco', latin: 'Nicotiana tabacum' } },
    { label: 'Custom...', value: '__custom__' },
  ],
  bacteria: [
    { label: 'Escherichia coli K-12 MG1655', value: 'escherichia_coli_str_k_12_substr_mg1655_gca_000005845', rich: { latin: 'Escherichia coli', strain: 'K-12 MG1655' } },
    { label: 'Bacillus subtilis 168', value: 'bacillus_subtilis_subsp_subtilis_str_168_gca_000009045', rich: { latin: 'Bacillus subtilis', strain: '168' } },
    { label: 'Staphylococcus aureus NCTC 8325', value: 'staphylococcus_aureus_subsp_aureus_nctc_8325_gca_000013425', rich: { latin: 'Staphylococcus aureus', strain: 'NCTC 8325' } },
    { label: 'Pseudomonas aeruginosa PAO1', value: 'pseudomonas_aeruginosa_pao1_gca_000006765', rich: { latin: 'Pseudomonas aeruginosa', strain: 'PAO1' } },
    { label: 'Mycobacterium tuberculosis H37Ra', value: 'mycobacterium_tuberculosis_h37ra_gca_000016145', rich: { latin: 'Mycobacterium tuberculosis', strain: 'H37Ra' } },
    { label: 'Salmonella enterica Typhimurium LT2', value: 'salmonella_enterica_subsp_enterica_serovar_typhimurium_str_lt2_gca_000006945', rich: { latin: 'Salmonella enterica', strain: 'Typhimurium LT2' } },
    { label: 'Streptococcus pneumoniae TIGR4', value: 'streptococcus_pneumoniae_tigr4_gca_000006885', rich: { latin: 'Streptococcus pneumoniae', strain: 'TIGR4' } },
    { label: 'Custom...', value: '__custom__' },
  ],
  fungi: [
    { label: 'Saccharomyces cerevisiae', value: 'saccharomyces_cerevisiae', rich: { latin: 'Saccharomyces cerevisiae' } },
    { label: 'Schizosaccharomyces pombe', value: 'schizosaccharomyces_pombe', rich: { latin: 'Schizosaccharomyces pombe' } },
    { label: 'Aspergillus nidulans', value: 'aspergillus_nidulans', rich: { latin: 'Aspergillus nidulans' } },
    { label: 'Neurospora crassa', value: 'neurospora_crassa', rich: { latin: 'Neurospora crassa' } },
    { label: 'Candida albicans', value: 'candida_albicans', rich: { latin: 'Candida albicans' } },
    { label: 'Custom...', value: '__custom__' },
  ],
  protists: [
    { label: 'Plasmodium falciparum 3D7', value: 'plasmodium_falciparum', rich: { latin: 'Plasmodium falciparum', strain: '3D7' } },
    { label: 'Trypanosoma brucei', value: 'trypanosoma_brucei', rich: { latin: 'Trypanosoma brucei' } },
    { label: 'Leishmania major', value: 'leishmania_major', rich: { latin: 'Leishmania major' } },
    { label: 'Dictyostelium discoideum', value: 'dictyostelium_discoideum', rich: { latin: 'Dictyostelium discoideum' } },
    { label: 'Toxoplasma gondii', value: 'toxoplasma_gondii_me49', rich: { latin: 'Toxoplasma gondii' } },
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
