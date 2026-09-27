import { postJson } from './client';

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
