import { postJson } from './client';

// Matches `crates/server/src/routes/{search_variants,lookup_variant}.rs`.

export interface VariantHit {
  id: string;
  chrom: string;
  /** 1-based inclusive genomic. */
  start: number;
  end: number;
  /** Order NOT guaranteed ref-first by Ensembl — the UI must let the user
   * confirm which allele is ref vs alt, never assume `alleles[0]`. */
  alleles: string[];
  strand: number;
  consequence_type: string | null;
  clinical_significance: string[];
  /** Global minor allele frequency. Only populated when this hit came from
   * `lookupVariant` (search by rsID/code) — `searchVariants` (search by
   * position/region) always returns `null` here; the UI fetches it on
   * demand per-row via `lookupVariant`. */
  minor_allele_freq: number | null;
  minor_allele: string | null;
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

export interface LookupVariantRequest {
  /** An Ensembl/dbSNP rsID, or another catalog id Ensembl recognizes
   * (e.g. a HGMD/COSMIC accession). */
  variant_id: string;
  species: string;
}

export interface LookupVariantResponse {
  variant: VariantHit;
}

/** 404s (via `ApiError`) when the id isn't found in Ensembl for the given
 * species — same not-found convention as `searchGene`. */
export function lookupVariant(req: LookupVariantRequest): Promise<LookupVariantResponse> {
  return postJson<LookupVariantResponse>('/lookup_variant', req);
}
