import { postJson } from './client';

// Matches `crates/server/src/routes/analyze_structure.rs`.

export interface AnalyzeStructureRequest {
  sequence: string;
  /** Absent for a self-dimer only; present to additionally compute a
   * heterodimer against a different sequence. */
  partner_sequence?: string;
  mv_conc?: number;
  dv_conc?: number;
  dntp_conc?: number;
  dna_conc?: number;
}

/** One subopt candidate's own stats - `StructureVariant.candidates` holds
 * up to 5 of these, best (index 0) first. */
export interface StructureCandidate {
  dg: number;
  tm: number;
  structure: string;
  /** Boltzmann share of this candidate's ΔG within this model's own top-5
   * subopt ensemble (bulge-allowing or no-bulge — never mixed). */
  population_fraction: number;
}

export interface StructureVariant {
  structure_found: boolean;
  /** Mirror `candidates[0]` — kept as plain scalars for callers (like
   * `PrimerCard.tsx`) that only ever show the single best structure. */
  dg: number | null;
  tm: number | null;
  structure: string | null;
  population_fraction: number | null;
  /** Every subopt candidate found, up to 5 — for callers that want to
   * show more than just the top structure (see `PrimerStructureModal.tsx`). */
  candidates: StructureCandidate[];
}

export interface DualStructure {
  with_bulge: StructureVariant;
  no_bulge: StructureVariant;
}

export interface FullStructureAnalysis {
  hairpin: DualStructure;
  /** Always `sequence` folded against itself, regardless of whether
   * `partner_sequence` was given. */
  homodimer: DualStructure;
  /** `sequence` against `partner_sequence` — `null` when no partner was given. */
  heterodimer: DualStructure | null;
}

export function analyzeStructure(req: AnalyzeStructureRequest): Promise<FullStructureAnalysis> {
  return postJson<FullStructureAnalysis>('/analyze_structure', req);
}
