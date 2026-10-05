import { postJson } from './client';
import { getNcbiApiKey } from './ncbiApiKey';

// Matches `crates/server/src/routes/blast.rs` (`BlastHitJson` flattens
// `blast::parse::BlastHit` plus one extra `ensembl_species` field).

export interface BlastHit {
  organism: string;
  gene_symbol: string | null;
  accession: string;
  title: string;
  evalue: number | null;
  bit_score: number | null;
  identity_pct: number;
  query_cover: number;
  query_from: number;
  query_to: number;
  hit_from: number;
  hit_to: number;
  query_len: number;
  /** Only present on synthetic hits produced by direct accession
      resolution (no BLAST round-trip). */
  direct?: boolean;
  ensembl_species: string;
}

export interface BlastSequenceResponse {
  hits: BlastHit[];
}

export function blastSequence(sequence: string): Promise<BlastSequenceResponse> {
  // Server ignores an empty key; mirrors Oligool's `/search` request shape.
  return postJson<BlastSequenceResponse>('/blast_sequence', { sequence, api_key: getNcbiApiKey() });
}

// Matches `crates/server/src/routes/blast.rs`'s `/blast_batch`.

export interface BlastBatchQuery {
  /** FASTA-header-safe and unique within the request (A-Z a-z 0-9 . _ + -);
   * the server echoes it back as the key each result is reported under. */
  id: string;
  sequence: string;
}

export interface BlastBatchResult {
  id: string;
  status: 'done' | 'error';
  hits?: BlastHit[];
  error?: string;
}

export interface BlastBatchResponse {
  results: BlastBatchResult[];
}

/** BLASTs many named sequences in ONE multi-query NCBI submission — one
 * ~30-180s round-trip for the whole list, not one per sequence. Batches
 * larger than the server's per-request cap (100) must be chunked by the
 * caller. */
export function blastBatch(queries: BlastBatchQuery[]): Promise<BlastBatchResponse> {
  return postJson<BlastBatchResponse>('/blast_batch', { queries, api_key: getNcbiApiKey() });
}
