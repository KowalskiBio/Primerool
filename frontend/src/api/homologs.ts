import { getJson, postJson } from './client';

// Matches `crates/server/src/routes/homologs.rs`.

/** One species' CDS of the gene (`providers::ncbi::Homolog`). */
export interface Homolog {
  /** "Pseudomonas veronii", or the full name of an unnamed isolate. */
  species: string;
  isolate: boolean;
  organism: string;
  strain: string | null;
  gene: string;
  protein: string;
  accession: string;
  start: number;
  end: number;
  minus_strand: boolean;
  /** The CDS, 5'->3' in the gene's own sense. */
  sequence: string;
}

export interface HomologJob {
  status: 'running' | 'done' | 'error';
  homologs?: Homolog[];
  error?: string;
}

/** Starts collecting one CDS of `gene` per species within `taxon` (a name
 * like "Pseudomonas" or a taxonomy ID) as a background job - keyless
 * NCBI takes a minute or more - polled with `getHomologJob`. */
export function startCollectHomologs(gene: string, taxon: string, maxSpecies: number): Promise<{ job_id: string }> {
  return postJson<{ job_id: string }>('/collect_homologs', { gene, taxon, max_species: maxSpecies });
}

export function getHomologJob(jobId: string): Promise<HomologJob> {
  return getJson<HomologJob>(`/collect_homologs_status/${encodeURIComponent(jobId)}`);
}
