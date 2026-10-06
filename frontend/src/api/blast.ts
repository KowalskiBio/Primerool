import { getJson, postJson } from './client';
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
  /** The best HSP's aligned query, target (in the query's orientation) and
   * match line (`|` identity, space mismatch; gaps are `-`). Absent on
   * direct-accession hits and on results saved before they existed. */
  qseq?: string;
  hseq?: string;
  midline?: string;
  ensembl_species: string;
}

export interface BlastSequenceResponse {
  hits: BlastHit[];
}

export function blastSequence(sequence: string): Promise<BlastSequenceResponse> {
  // Server ignores an empty key; mirrors Oligool's `/search` request shape.
  return postJson<BlastSequenceResponse>('/blast_sequence', { sequence, api_key: getNcbiApiKey() });
}

// Matches `crates/server/src/routes/blast.rs`'s `/blast_hit_flanks`.

export interface HitFlanks {
  /** Subject bases, in the query's orientation, opposite the primer's
   * dangling 5' end (first) and 3' end (second) — each at most the
   * dangling length, shorter when the hit's own sequence runs out. */
  five: string;
  three: string;
}

/** Fetches the subject bases a hit has opposite the primer ends BLAST's
 * local alignment left unaligned (it reports only the stretch it
 * aligned), so the alignment can be shown over the primer's full length
 * with the real mismatching bases instead of blanks. Built entirely from
 * one `BlastHit`'s fields, so callers pass the hit they display. */
export function fetchBlastHitFlanks(hit: BlastHit): Promise<HitFlanks> {
  return postJson<HitFlanks>('/blast_hit_flanks', {
    accession: hit.accession,
    hit_from: hit.hit_from,
    hit_to: hit.hit_to,
    query_from: hit.query_from,
    query_to: hit.query_to,
    query_len: hit.query_len,
    api_key: getNcbiApiKey(),
  });
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

/** Starts a batch BLAST of many named sequences as ONE multi-query NCBI
 * submission. Returns immediately with a job id — the NCBI round-trip
 * (~30-600s) happens server-side, and the results are polled via
 * `getBlastBatchJob` (a synchronous response would be cut off by a
 * reverse proxy's ~60s timeout with a 504). Batches larger than the
 * server's per-request cap (100) must be chunked by the caller.
 * `organism` (an Ensembl species slug like 'homo_sapiens', or an
 * organism name like 'Homo sapiens') restricts the search to that
 * organism via NCBI's ENTREZ_QUERY. */
export function startBlastBatch(queries: BlastBatchQuery[], organism: string): Promise<BlastBatchStarted> {
  return postJson<BlastBatchStarted>('/blast_batch', { queries, organism, api_key: getNcbiApiKey() });
}

export interface BlastBatchStarted {
  job_id: string;
}

export interface BlastBatchJob {
  status: 'running' | 'done' | 'error';
  results?: BlastBatchResult[];
  error?: string;
}

/** Polls a `startBlastBatch` job: `running` until the background BLAST
 * finishes, then the per-query results (or the job's error). An unknown
 * id (expired, or lost to a server restart/deploy) is a 404 `ApiError`. */
export function getBlastBatchJob(jobId: string): Promise<BlastBatchJob> {
  return getJson<BlastBatchJob>(`/blast_batch_status/${encodeURIComponent(jobId)}`);
}

// Matches `crates/server/src/routes/hit_genes.rs`.

/** A gene a hit's record annotates at the hit's position. */
export interface HitGene {
  symbol: string;
  synonyms: string[];
  /** NCBI Gene ID, when the record cross-references one. */
  gene_id?: string;
}

export interface HitGenesResponse {
  /** `false` when the lookup failed upstream. */
  ok: boolean;
  /** Empty with `ok`: nothing annotated there (e.g. a BAC clone). */
  genes: HitGene[];
}

/** Which gene(s) a BLAST hit actually lies in, from the hit record's own
 * feature table over the hit's span - not its title (a RefSeqGene titled
 * after one gene also spans its neighbours). */
export function fetchHitGenes(hit: BlastHit): Promise<HitGenesResponse> {
  return postJson<HitGenesResponse>('/blast_hit_genes', { accession: hit.accession, from: hit.hit_from, to: hit.hit_to, api_key: getNcbiApiKey() });
}

export interface GeneAliasesResponse {
  ok: boolean;
  /** Official symbol first, then the gene's other names. */
  aliases: string[];
}

/** A gene's official symbol and other names in one organism (an Ensembl
 * species slug like 'homo_sapiens'), from NCBI Gene. */
export function fetchGeneAliases(symbol: string, organism: string): Promise<GeneAliasesResponse> {
  return postJson<GeneAliasesResponse>('/gene_aliases', { symbol, organism, api_key: getNcbiApiKey() });
}
