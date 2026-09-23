import type { SequenceData } from '../api/sequence';

/** The SNP-flanking-report workflow only ever deals in GRCh38 human
 * variants (see `SNP_flanking_sequences_GRCh38.docx`), so unlike the main
 * gene-search workflow there's no species/source picker upstream to read
 * this from - it's fixed here instead. Shared by `SnpBatchPanel.tsx` and
 * `SnpGeneMapModal.tsx`. */
export const SNP_WORKFLOW_SPECIES = 'homo_sapiens';

/** Maps a 1-based genomic position onto a 0-based offset into
 * `data.gene_seq` - only meaningful when `data.include_introns` is true
 * (only then is `gene_seq` the linear genomic template `gene_start_genomic`/
 * `gene_end_genomic` describe). Same formula `ArmsDesignPanel.tsx` uses for
 * variant-search hits. */
export function localGenePos(data: SequenceData, genomicPos: number): number | null {
  const local = data.strand === '-' ? data.gene_end_genomic - genomicPos : genomicPos - data.gene_start_genomic;
  if (local < 0 || local >= data.gene_seq.length) return null;
  return local;
}
