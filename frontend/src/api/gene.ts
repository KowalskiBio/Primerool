import { postJson } from './client';
import type { BlastHit } from './blast';

// Matches `crates/server/src/routes/gene.rs`.

export interface SearchGeneRequest {
  gene_name: string;
  species: string;
  api_source: string;
}

export interface Transcript {
  id: string;
  name: string;
  exon_count: number;
  strand: string;
  is_canonical: boolean;
}

export interface SearchGeneResponse {
  gene_name: string;
  /** What was searched for, as typed. */
  query: string;
  /** How `query` resolved to `gene_name`: `symbol` = it is the gene's
   * official symbol; `alias` = it is only one of the gene's alternative
   * symbols; `name` = matched by name/description text. Anything but
   * `symbol` must be surfaced to the user - the gene may not be the one
   * they meant (e.g. NCBI's COPS2 lists "CSN2" as an alias). */
  matched_by: 'symbol' | 'alias' | 'name';
  transcripts: Transcript[];
}

export function searchGene(req: SearchGeneRequest): Promise<SearchGeneResponse> {
  return postJson<SearchGeneResponse>('/search_gene', req);
}

/** Loads the stretch of the record a BLAST hit covers as a gene with one
 * transcript - for genes NCBI has no Gene record for. The transcript
 * lives in the NCBI provider, so continue with `api_source` `ncbi`. */
export function loadBlastHit(hit: BlastHit): Promise<SearchGeneResponse> {
  return postJson<SearchGeneResponse>('/load_blast_hit', {
    accession: hit.accession,
    hit_from: hit.hit_from,
    hit_to: hit.hit_to,
    gene_name: hit.gene_symbol || hit.accession,
    organism: hit.organism,
  });
}
