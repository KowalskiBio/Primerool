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
  transcripts: Transcript[];
}

export function searchGene(req: SearchGeneRequest): Promise<SearchGeneResponse> {
  return postJson<SearchGeneResponse>('/search_gene', req);
}
