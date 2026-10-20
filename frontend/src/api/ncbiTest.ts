import { getJson, postJson } from './client';

// Matches `crates/server/src/routes/ncbi_test.rs`.

export interface NcbiCheck {
  ok: boolean;
  seconds: number;
  detail: string;
}

export interface NcbiTestResponse {
  eutils: NcbiCheck;
  blast_submit: NcbiCheck;
  /** The test search's id, when BLAST accepted it. */
  rid: string | null;
}

/** Checks E-utilities (and whether it accepts `apiKey`) and submits a tiny
 * BLAST search. */
export function startNcbiTest(apiKey: string): Promise<NcbiTestResponse> {
  return postJson<NcbiTestResponse>('/ncbi/test', { api_key: apiKey });
}

/** Asks once whether the test search has left NCBI's queue - call it a
 * minute after `startNcbiTest` (NCBI allows one status check per minute). */
export function checkNcbiTestQueue(rid: string): Promise<NcbiCheck> {
  return getJson<NcbiCheck>(`/ncbi/test/${encodeURIComponent(rid)}`);
}
