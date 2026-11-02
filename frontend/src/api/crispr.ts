import { postJson } from './client';
import type { PrimerAnalysis } from './design';

// Matches `crates/server/src/routes/design_crispr.rs`.
//
// Note this route does NOT use any of the four Primer3-inherited oligo
// coordinate conventions documented in `design.ts`: a guide has no
// forward/reverse asymmetry to preserve, so `interval` and `pam_interval`
// are plain `[start, end)` and need no conversion through `utils/coords.ts`.

/** A cloning vector the guide oligos can be ordered for. Both take the
 * same CACC/AAAC overhangs and differ only in the enzyme that opens the
 * backbone. */
export type CloningVectorName = 'pX330' | 'lentiCRISPRv2';

export interface GuideWarning {
  code: string;
  message: string;
}

export interface CloningOligos {
  vector: CloningVectorName;
  enzyme: string;
  /** The spacer as cloned - 21 nt when a 5' G had to be added. */
  cloned_spacer: string;
  added_5prime_g: boolean;
  /** 5'-CACC + cloned spacer-3'. */
  top: string;
  /** 5'-AAAC + revcomp(cloned spacer)-3'. */
  bottom: string;
}

export interface GuideResult extends PrimerAnalysis {
  /** The protospacer's `[start, end)`, always in plus-strand coordinates
   * of whatever sequence was sent (plus the request's `offset`). */
  interval: [number, number];
  /** The PAM's `[start, end)`, likewise plus-strand. */
  pam_interval: [number, number];
  /** Which strand the spacer reads on. `sequence` is already on that
   * strand, so a `'-'` guide's sequence is the reverse complement of the
   * template at `interval`. */
  strand: '+' | '-';
  /** Always NGG for SpCas9, read on the guide's own strand. */
  pam: string;
  /** The blunt cut: the nick falls between `cut_site - 1` and `cut_site`. */
  cut_site: number;
  /** A transparent 0-100 heuristic rank, not a published on-target score -
   * every deduction behind it is listed in `warnings`. */
  score: number;
  warnings: GuideWarning[];
  cloning: CloningOligos;
}

export interface DesignCrisprResponse {
  guides: GuideResult[];
  /** What the PAM scan found and threw away, in one line. */
  explain: string;
}

export interface CrisprConditions {
  gc_min?: number;
  gc_max?: number;
  num_return?: number;
  allow_poly_t?: boolean;
  vector?: CloningVectorName;
}

export function designCrispr(region: string, offset: number, conditions: CrisprConditions): Promise<DesignCrisprResponse> {
  return postJson<DesignCrisprResponse>('/design_crispr', { region, offset, conditions });
}
