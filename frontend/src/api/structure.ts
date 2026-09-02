import { postJson } from './client';

// Matches `crates/server/src/routes/analyze_structure.rs`.

export interface AnalyzeStructureRequest {
  sequence: string;
  /** Absent for a self-dimer; present for a heterodimer against a different sequence. */
  partner_sequence?: string;
  mv_conc?: number;
  dv_conc?: number;
  dntp_conc?: number;
  dna_conc?: number;
}

export interface StructureVariant {
  structure_found: boolean;
  dg: number | null;
  tm: number | null;
  structure: string | null;
  /** Boltzmann share of this structure's ΔG within the top-N subopt
   * candidates of its own model (bulge-allowing or no-bulge — never mixed). */
  population_fraction: number | null;
}

export interface DualStructure {
  with_bulge: StructureVariant;
  no_bulge: StructureVariant;
}

export interface FullStructureAnalysis {
  hairpin: DualStructure;
  homodimer: DualStructure;
}

export function analyzeStructure(req: AnalyzeStructureRequest): Promise<FullStructureAnalysis> {
  return postJson<FullStructureAnalysis>('/analyze_structure', req);
}
