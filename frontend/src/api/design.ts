import { postJson } from './client';

// Matches `crates/server/src/routes/{design_primers,design_from_sequence,design_probe,design_arms}.rs`.
//
// Four distinct oligo-coordinate wire conventions across these routes
// (documented in the rewrite plan's Phase 6a) — callers must NOT treat
// "position"/"coords"/"interval" uniformly:
//   - classic internal mode & `/design_from_sequence`'s `coords`: the raw,
//     asymmetric primer3 tuple — `[start, length]` for forward/internal
//     oligos, `[right_end, length]` for reverse oligos.
//   - flanking mode's `position`: *normalized* `[start, length]` (a
//     separate `position_raw` field carries the raw tuple above).
//   - junction mode's `position`: normalized `[start, length]` only (no
//     raw-tuple field at all).
//   - `/design_arms`'s `position`: also normalized `[start, length]` only —
//     new surface with no legacy shape to preserve, so this convention was
//     picked deliberately to match flanking/junction rather than adding a
//     fifth, undocumented variant.
// `utils/coords.ts` provides the two conversion functions
// (`rawTupleToInterval`, `normalizedTupleToInterval`) needed to turn any of
// these into a plain `[start, end)` interval for highlighting.

export interface DimerResult {
  structure_found: boolean;
  tm: number | null;
  dg: number | null;
}

export interface PrimerAnalysis {
  sequence: string;
  length: number;
  gc_percent: number | null;
  tm: number | null;
  hairpin: DimerResult;
  homodimer: DimerResult;
}

export interface PairAnalysis {
  heterodimer: DimerResult;
}

export interface AdvancedThermo {
  mv_conc?: number;
  dv_conc?: number;
  dntp_conc?: number;
  dna_conc?: number;
  max_poly_x?: number;
  max_ns?: number;
}

/** `"primer3"` (default) uses the real primer3 C library via FFI;
 * `"native"` uses thermo-core's from-scratch Rust engine — now
 * Mathews2004-accurate for hairpin/dimer Tm (matching Oligool's own
 * default `parameter_set="mathews2004-dna"`), though it still ranks
 * *candidate* primers differently than primer3 (see
 * crates/engine/native_vs_primer3_report.md). */
export type DesignEngine = 'primer3' | 'native';

// ---------------------------------------------------------------------
// /design_primers — classic internal (SEQUENCE_TARGET)
// ---------------------------------------------------------------------

export interface InternalDesignSide {
  sequence: string;
  tm: number;
  gc: number;
  /** Raw primer3 tuple — see module docs. */
  position: [number, number];
}

export interface InternalDesignPair {
  pair_number: number;
  left: InternalDesignSide;
  right: InternalDesignSide;
  product_size: number;
}

export interface InternalDesignResponse {
  mode: 'internal';
  num_pairs: number;
  primers: InternalDesignPair[];
}

export function designInternal(sequence: string, target_start: number, target_end: number): Promise<InternalDesignResponse> {
  // No `engine` param: classic-internal mode (`design_internal_mode` server-side)
  // never runs analyze_primer/hairpin/dimer QC at all — it's a raw primer3
  // SEQUENCE_TARGET call with no ThermoBackend involved, so there's nothing to select.
  return postJson<InternalDesignResponse>('/design_primers', { mode: 'internal', sequence, target_start, target_end });
}

// ---------------------------------------------------------------------
// /design_primers — exon-exon junction
// ---------------------------------------------------------------------

export interface JunctionOligoResult extends PrimerAnalysis {
  /** `[start, end)` into the spliced (exon-only) template. */
  interval: [number, number];
  /** Normalized `[start, length]` — NOT the raw primer3 tuple, unlike
   * classic-internal/design_from_sequence. */
  position: [number, number];
}

export interface JunctionPairResult {
  pair_number: number;
  junction_pos: number;
  junction_spanning: 'left';
  left: JunctionOligoResult;
  right: JunctionOligoResult;
  product_size: number;
  pair_metrics: PairAnalysis;
}

export interface JunctionDesignResponse {
  mode: 'internal';
  num_pairs: number;
  primers: { pairs: JunctionPairResult[] };
}

export interface JunctionDesignParams {
  sequence: string;
  junction_pos: number;
  junction_overlap_min?: number;
  junction_overlap_max?: number;
  amplicon_min?: number;
  amplicon_max?: number;
  junction_left_pad?: number;
  junction_right_pad?: number;
  junction_max_candidates?: number;
  engine?: DesignEngine;
}

export function designJunction(params: JunctionDesignParams): Promise<JunctionDesignResponse> {
  return postJson<JunctionDesignResponse>('/design_primers', { mode: 'internal', ...params });
}

/** Runtime discriminant: classic-internal's `primers` is an array, junction
 * mode's is `{pairs: [...]}` — both report `mode: "internal"`, so the
 * `mode` field alone can't tell them apart (matches the server, which
 * dispatches on whether `junction_pos` was present in the *request*, not
 * on anything in the response). */
export function isJunctionResponse(res: InternalDesignResponse | JunctionDesignResponse): res is JunctionDesignResponse {
  return !Array.isArray(res.primers);
}

// ---------------------------------------------------------------------
// /design_primers — flanking (WGA)
// ---------------------------------------------------------------------

export interface FlankingOligoResult extends PrimerAnalysis {
  interval: [number, number];
  /** Normalized `[start, length]`. */
  position: [number, number];
  /** The raw, asymmetric primer3 tuple for the same oligo. */
  position_raw: [number, number];
  primer3: {
    tm: number;
    gc_percent: number;
    /** Always `null` in real server output — a faithfully-preserved
     * `primer_flanking.py` bug (see `crates/server/src/routes/design_primers.rs`). */
    self_any: null;
    self_end: null;
    hairpin_th: number;
  };
}

export interface FlankingDesignResponse {
  mode: 'flanking';
  primers: {
    forward: { num_returned: number; explain: string | null; primers: FlankingOligoResult[] };
    reverse: { num_returned: number; explain: string | null; primers: FlankingOligoResult[] };
    pair_metrics: PairAnalysis | null;
  };
}

export function designFlanking(upstream_seq: string, downstream_seq: string, engine?: DesignEngine): Promise<FlankingDesignResponse> {
  return postJson<FlankingDesignResponse>('/design_primers', { mode: 'flanking', upstream_seq, downstream_seq, engine });
}

// ---------------------------------------------------------------------
// /design_from_sequence
// ---------------------------------------------------------------------

export interface FromSequenceConditions {
  advanced?: AdvancedThermo;
  tm_min?: number;
  tm_opt?: number;
  tm_max?: number;
  len_min?: number;
  len_opt?: number;
  len_max?: number;
  gc_min?: number;
  gc_max?: number;
  num_return?: number;
}

export interface DesignFromSequenceRequest {
  forward_region: string;
  reverse_region: string;
  /** Non-empty triggers the unified `SEQUENCE_PRIMER_PAIR_OK_REGION_LIST`
   * path; empty/omitted triggers the independent-fallback path (see the
   * plan's documented pair-ranking caveat on the unified path). */
  template_seq?: string;
  fwd_pos?: number;
  rev_pos?: number;
  amplicon_target?: number;
  amplicon_deviation?: number;
  conditions?: FromSequenceConditions;
  engine?: DesignEngine;
}

export interface FromSequencePrimerResult extends PrimerAnalysis {
  /** Present only in the unified path — the raw primer3 tuple. Absent
   * (not null) in the independent-fallback path. */
  coords?: [number, number];
}

export interface BestPairResult {
  forward_seq: string;
  forward_tm: number | null;
  forward_coords?: [number, number];
  reverse_seq: string;
  reverse_tm: number | null;
  reverse_coords?: [number, number];
  tm_diff: number;
  heterodimer: DimerResult;
  score: number;
  /** Present only in the unified path. */
  product_size?: number;
}

export interface DesignFromSequenceResponse {
  forward_primers: FromSequencePrimerResult[];
  reverse_primers: FromSequencePrimerResult[];
  best_pairs: BestPairResult[];
}

export function designFromSequence(req: DesignFromSequenceRequest): Promise<DesignFromSequenceResponse> {
  return postJson<DesignFromSequenceResponse>('/design_from_sequence', req);
}

// ---------------------------------------------------------------------
// /design_probe
// ---------------------------------------------------------------------

export interface ProbeConditions {
  advanced?: AdvancedThermo;
  probe_tm_min?: number;
  probe_tm_opt?: number;
  probe_tm_max?: number;
  probe_len_min?: number;
  probe_len_opt?: number;
  probe_len_max?: number;
  probe_gc_min?: number;
  probe_gc_max?: number;
  num_return?: number;
}

export interface ProbeResult extends PrimerAnalysis {
  /** Raw primer3 tuple `[start, length]` — probes are always sense-strand,
   * so this coincides with the normalized form. */
  coords: [number, number];
}

export interface DesignProbeResponse {
  probes: ProbeResult[];
}

export function designProbe(probe_region: string, conditions?: ProbeConditions, engine?: DesignEngine): Promise<DesignProbeResponse> {
  return postJson<DesignProbeResponse>('/design_probe', { probe_region, conditions, engine });
}

// ---------------------------------------------------------------------
// /design_arms — SNP/indel ARMS-PCR. New surface, no legacy Python route —
// see `crates/server/src/routes/design_arms.rs`'s module docs.
// ---------------------------------------------------------------------

export interface ArmsAllelePrimerResult extends PrimerAnalysis {
  interval: [number, number];
  /** Normalized `[start, length]` — see this file's header comment. */
  position: [number, number];
  allele: 'ref' | 'alt';
  /** 0-based index into this primer's own sequence, or `null` if no
   * mismatch was applied. */
  mismatch_position: number | null;
}

export interface ArmsCommonCandidateResult extends PrimerAnalysis {
  interval: [number, number];
  position: [number, number];
  product_size_ref: number;
  product_size_alt: number;
  pair_metrics_ref: PairAnalysis;
  pair_metrics_alt: PairAnalysis;
}

export interface DesignArmsRequest {
  sequence: string;
  variant_pos: number;
  ref_allele: string;
  alt_allele: string;
  mismatch_enabled?: boolean;
  mismatch_offset?: number;
  mismatch_base?: string;
  common_pad?: number;
  product_min?: number;
  product_max?: number;
  max_common_candidates?: number;
  advanced?: AdvancedThermo;
  engine?: DesignEngine;
}

export interface DesignArmsResponse {
  mode: 'arms';
  variant: { pos: number; ref_allele: string; alt_allele: string };
  ref_primer: ArmsAllelePrimerResult;
  alt_primer: ArmsAllelePrimerResult;
  common_candidates: ArmsCommonCandidateResult[];
}

export function designArms(req: DesignArmsRequest): Promise<DesignArmsResponse> {
  return postJson<DesignArmsResponse>('/design_arms', req);
}

// ---------------------------------------------------------------------
// /analyze_primer — recomputes Tm/GC%/hairpin/homodimer for an arbitrary
// sequence. Used by the sequence view's interactive drag/resize editing
// (`SequenceViewer.tsx`) to re-validate a primer/probe after it's been
// moved or widened/shortened — see `crates/server/src/routes/analyze_primer.rs`.
// ---------------------------------------------------------------------

export interface AnalyzePrimerRequest {
  sequence: string;
  mv_conc?: number;
  dv_conc?: number;
  dntp_conc?: number;
  dna_conc?: number;
}

export function analyzePrimer(req: AnalyzePrimerRequest): Promise<PrimerAnalysis> {
  return postJson<PrimerAnalysis>('/analyze_primer', req);
}
