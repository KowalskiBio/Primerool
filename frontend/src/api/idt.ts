import { postJson } from './client';
import type { PrimerAnalysis, PairAnalysis } from './design';

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
  };
}

export function idtAnalyze(req: IdtAnalyzeRequest): Promise<IdtAnalyzeResponse> {
  return postJson<IdtAnalyzeResponse>('/idt/analyze', req);
}
