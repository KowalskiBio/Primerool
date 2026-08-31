import { postJson } from './client';

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
  ensembl_species: string;
}

export interface BlastSequenceResponse {
  hits: BlastHit[];
}

export function blastSequence(sequence: string): Promise<BlastSequenceResponse> {
  return postJson<BlastSequenceResponse>('/blast_sequence', { sequence });
}
