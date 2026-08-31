import { postJson } from './client';

// Matches `crates/server/src/routes/search_variants.rs`.

export interface VariantHit {
  id: string;
  /** 1-based inclusive genomic. */
  start: number;
  end: number;
  /** Order NOT guaranteed ref-first by Ensembl — the UI must let the user
   * confirm which allele is ref vs alt, never assume `alleles[0]`. */
  alleles: string[];
  strand: number;
  consequence_type: string | null;
  clinical_significance: string[];
}

export interface SearchVariantsRequest {
  chrom: string;
  species: string;
  /** 1-based inclusive genomic. */
  start: number;
  end: number;
}

export interface SearchVariantsResponse {
  variants: VariantHit[];
}

export function searchVariants(req: SearchVariantsRequest): Promise<SearchVariantsResponse> {
  return postJson<SearchVariantsResponse>('/search_variants', req);
}
