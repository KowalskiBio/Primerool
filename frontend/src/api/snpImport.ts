import { postJson } from './client';

// Matches `crates/server/src/routes/import_snp.rs`.

export interface SnpBlock {
  gene: string;
  rsid: string;
  chrom: string;
  position: number;
  /** Reference allele first. */
  alleles: string[];
  refseq: string;
  interval_start: number;
  interval_end: number;
  /** Reference bases immediately upstream (5') of the variant. */
  upstream_seq: string;
  /** Reference bases immediately downstream (3') of the variant. */
  downstream_seq: string;
  /** rsIDs of other SNPs from the same report that fall inside this window. */
  other_targets: string[];
}

export interface ImportSnpResponse {
  blocks: SnpBlock[];
}

export function importSnpDocx(base64: string): Promise<ImportSnpResponse> {
  return postJson<ImportSnpResponse>('/import_snp_blocks', { docx_base64: base64 });
}

export function importSnpText(text: string): Promise<ImportSnpResponse> {
  return postJson<ImportSnpResponse>('/import_snp_blocks', { text });
}
