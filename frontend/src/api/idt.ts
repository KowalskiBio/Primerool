import { postJson } from './client';
import type { PrimerAnalysis, PairAnalysis, DesignEngine } from './design';

// Matches `crates/server/src/routes/idt.rs` (Phase 8).

export interface IdtTokenRequest {
  client_id: string;
  client_secret: string;
  username: string;
  password: string;
  idt_region: 'us' | 'eu';
}

/** IDT's own token response, passed through verbatim by the server — only
 * the one field actually used (`access_token`) is typed here. */
export interface IdtTokenResponse {
  access_token: string;
  [key: string]: unknown;
}

export function getIdtToken(req: IdtTokenRequest): Promise<IdtTokenResponse> {
  return postJson<IdtTokenResponse>('/idt/token', req);
}

export interface IdtAnalyzeRequest {
  p1_seq: string;
  p2_seq: string;
  token: string;
  mv_conc?: number;
  mg_conc?: number;
  dntp_conc?: number;
  oligo_conc?: number;
  idt_region: 'us' | 'eu';
  /** Which backend computes the "local" recompute alongside IDT's numbers.
   * `"native"` also populates `native_hairpin`/`native_self_dimer_subopt`/
   * `native_hetero_dimer_subopt` below — data with no primer3 equivalent
   * (primer3's `thal()` has no suboptimal-structure enumeration). */
  engine?: DesignEngine;
}

/** A single folded structure from `thermo_core::thermo` (hairpin or dimer),
 * only ever populated when `engine: "native"` was requested. */
export interface NativeThermoStructure {
  tm: number;
  dh: number;
  ds: number;
  dg37: number;
  n_pairs: number;
  structure: string;
}

/** IDT's raw per-endpoint JSON, or `{error: string}` if that one call
 * failed — each of the seven underlying IDT calls fails independently
 * (see `crates/idt`'s docs), so a partial-failure response is a normal,
 * displayable shape, not an exceptional one. */
export type IdtRawResult = Record<string, unknown>;

export interface IdtAnalyzeSide {
  idt: {
    hairpin: IdtRawResult;
    self_dimer: IdtRawResult;
    analyze: IdtRawResult;
    hairpin_delta_g: number | null;
    self_dimer_delta_g: number | null;
  };
  local: PrimerAnalysis;
  /** `null` unless `engine: "native"` was requested. */
  native_hairpin: NativeThermoStructure | null;
  /** Top suboptimal self-dimer alignments; `[]` unless `engine: "native"`. */
  native_self_dimer_subopt: NativeThermoStructure[];
}

export interface IdtAnalyzeResponse {
  m1: IdtAnalyzeSide;
  m2: IdtAnalyzeSide;
  pairwise: {
    idt: {
      hetero_dimer: IdtRawResult;
      hetero_dimer_delta_g: number | null;
    };
    local: PairAnalysis;
    /** Top suboptimal heterodimer alignments; `[]` unless `engine: "native"`. */
    native_hetero_dimer_subopt: NativeThermoStructure[];
  };
}

export function idtAnalyze(req: IdtAnalyzeRequest): Promise<IdtAnalyzeResponse> {
  return postJson<IdtAnalyzeResponse>('/idt/analyze', req);
}
