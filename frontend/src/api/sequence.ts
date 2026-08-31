import { postJson } from './client';

// Matches `crates/server/src/routes/sequence.rs`.

export interface GetSequenceRequest {
  gene_name: string;
  transcript_id: string;
  species: string;
  api_source: string;
  upstream_bp: number;
  downstream_bp: number;
  include_introns: boolean;
  include_utr: boolean;
}

export interface Annotation {
  start: number;
  end: number;
  type: 'exon' | 'cds';
}

export interface Junction {
  index: number;
  pos: number;
  label: string;
}

/** The full `/get_sequence` response — the single largest piece of app
 * state, referenced throughout (feature map, sequence viewers, design
 * panels). Also used to model a locally-loaded "custom sequence" (pasted
 * FASTA with no annotations), which never calls this route at all — see
 * `utils/sequenceData.ts`'s `customSequenceData`. */
export interface SequenceData {
  gene_name: string;
  transcript_id: string;
  transcript_name: string;
  chrom: string;
  strand: string;
  /** 1-based inclusive genomic span of the transcript's exons — only
   * usable to map a genomic position into `gene_seq` when `include_introns`
   * is true (only then is `gene_seq` the linear genomic template). */
  gene_start_genomic: number;
  gene_end_genomic: number;
  upstream_len: number;
  gene_len: number;
  downstream_len: number;
  utr5_len: number;
  upstream_seq: string;
  gene_seq: string;
  downstream_seq: string;
  spliced_seq: string;
  spliced_exons_seq: string;
  junctions: Junction[];
  annotations: Annotation[];
  include_introns: boolean;
  include_utr: boolean;
}

export function getSequence(req: GetSequenceRequest): Promise<SequenceData> {
  return postJson<SequenceData>('/get_sequence', req);
}
