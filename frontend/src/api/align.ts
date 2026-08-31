import { postJson } from './client';
import type { DimerResult } from './design';

// Matches `crates/server/src/routes/align.rs` and `design_conserved.rs` (Phase 7).

export interface AlignSequenceInput {
  id: string;
  seq: string;
}

export interface AlignResponse {
  alignment: string;
}

export function alignSequences(sequences: AlignSequenceInput[]): Promise<AlignResponse> {
  return postJson<AlignResponse>('/align', { sequences });
}

export interface ConservedCandidate {
  sequence: string;
  start: number;
  end: number;
  tm: number;
  gc_percent: number;
  hairpin: DimerResult;
  self_dimer: DimerResult;
  penalty: number;
}

export interface ConservedScanResponse {
  mode: 'scan';
  consensus_length: number;
  candidates: ConservedCandidate[];
}

export interface ConservedPairOligo {
  sequence: string;
  start: number;
  end: number;
  tm: number;
  gc_percent: number;
  penalty: number;
}

export interface ConservedPair {
  left: ConservedPairOligo;
  right: ConservedPairOligo;
  product_size: number;
  heterodimer: DimerResult;
  penalty: number;
}

export interface ConservedPairsResponse {
  mode: 'pairs';
  consensus_length: number;
  pairs: ConservedPair[];
}

export interface DesignConservedRequest {
  alignment: string;
  col_start: number;
  col_end: number;
  target_start?: number;
  target_end?: number;
  backend?: 'primer3' | 'native';
  size_min?: number;
  size_opt?: number;
  size_max?: number;
  tm_min?: number;
  tm_opt?: number;
  tm_max?: number;
  gc_min?: number;
  gc_max?: number;
  product_size_min?: number;
  product_size_max?: number;
  num_return?: number;
}

export function designConserved(req: DesignConservedRequest): Promise<ConservedScanResponse | ConservedPairsResponse> {
  return postJson<ConservedScanResponse | ConservedPairsResponse>('/design_conserved', req);
}
