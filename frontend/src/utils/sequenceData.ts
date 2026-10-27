import type { SequenceData } from '../api/sequence';

/** A pasted sequence as `SequenceData`: all of it is the "gene", with no
 * flanks, exons, junctions or genomic coordinates - `transcript_id:
 * 'custom'` is what the panels check to leave out what needs those. */
export function customSequenceData(name: string, sequence: string): SequenceData {
  return {
    gene_name: name,
    transcript_id: 'custom',
    transcript_name: name,
    chrom: '',
    strand: '+',
    gene_start_genomic: 0,
    gene_end_genomic: 0,
    upstream_len: 0,
    gene_len: sequence.length,
    downstream_len: 0,
    utr5_len: 0,
    upstream_seq: '',
    gene_seq: sequence,
    downstream_seq: '',
    spliced_seq: sequence,
    spliced_exons_seq: sequence,
    junctions: [],
    annotations: [],
    include_introns: false,
    include_utr: false,
  };
}

export function isCustomSequence(data: SequenceData | null | undefined): boolean {
  return data?.transcript_id === 'custom';
}
