import type { Annotation, SequenceData } from '../api/sequence';
import type { PrimerAnalysis } from '../api/design';
import { reverseComplement } from './dna';

/** A currently-highlighted primer/probe pick — the legacy app's
 * `selectedWGAForward`/`selectedGeneProbe`/etc. globals, unified into one
 * shape. `region` says which coordinate space `start`/`end` are in. */
export interface Selection {
  region: 'up' | 'down' | 'gene' | 'spliced';
  start: number;
  end: number;
  primerSeq: string;
  bindingSeq: string;
  source: 'recommended' | 'manual';
  /** Backend-recomputed Tm/GC/hairpin/homodimer for `primerSeq`, populated
   * after an interactive drag/resize edit in `SequenceViewer.tsx` commits
   * (via `POST /analyze_primer`). `undefined` until that recompute
   * resolves, `null` if it isn't applicable (never set for
   * `source: 'recommended'` picks, which already carry their own
   * backend-computed values elsewhere). */
  analysis?: PrimerAnalysis | null;
}

export interface Range {
  start: number;
  end: number;
}

/** The seven independent "currently highlighted" slots the legacy app kept
 * as separate globals (`selectedWGAForward`, `selectedGeneProbe`, etc.) —
 * unified into one object, lifted to `App.tsx` since both the
 * visualization components (Card 3) and the design panels (Cards 4-5) need
 * to read and write it. */
export interface Selections {
  wgaForward: Selection | null;
  wgaReverse: Selection | null;
  juncLeft: Selection | null;
  juncRight: Selection | null;
  geneForward: Selection | null;
  geneReverse: Selection | null;
  geneProbe: Selection | null;
  armsRefPrimer: Selection | null;
  armsAltPrimer: Selection | null;
  armsCommon: Selection | null;
}

export const EMPTY_SELECTIONS: Selections = {
  wgaForward: null,
  wgaReverse: null,
  juncLeft: null,
  juncRight: null,
  geneForward: null,
  geneReverse: null,
  geneProbe: null,
  armsRefPrimer: null,
  armsAltPrimer: null,
  armsCommon: null,
};

function sortedExons(data: SequenceData): Annotation[] {
  return (data.annotations || []).filter((a) => a.type === 'exon').sort((a, b) => a.start - b.start);
}

/**
 * Maps a selection into genomic-gene-coordinate ranges (0-based, relative
 * to `data.gene_seq`). `'up'`/`'down'` selections are offset by
 * `upstream_len`/`gene_len`; `'gene'` selections pass through (clamped);
 * `'spliced'` selections walk the exon list, splitting across exon
 * boundaries as needed. As a last resort (e.g. a manually-pasted primer
 * with no region metadata at all), falls back to a plain substring search
 * for the primer sequence and its reverse-complement against the gene
 * sequence — this fallback chain is load-bearing, not decorative: it's
 * what lets a bare sequence still get highlighted correctly.
 */
export function mapPrimerToGenomic(p: Selection | null | undefined, data: SequenceData | null): Range[] {
  if (!p || !data) return [];
  const gene = data.gene_seq || '';
  const ranges: Range[] = [];

  if (p.region === 'up') {
    const upLen = data.upstream_len || 0;
    ranges.push({ start: p.start - upLen, end: p.end - upLen });
  } else if (p.region === 'down') {
    ranges.push({ start: data.gene_len + p.start, end: data.gene_len + p.end });
  } else if (p.region === 'gene') {
    const s = Math.max(0, p.start);
    const e = gene.length ? Math.min(gene.length, p.end) : p.end;
    if (e > s) ranges.push({ start: s, end: e });
  } else if (p.region === 'spliced') {
    let remainingStart = p.start;
    let remainingLen = p.end - p.start;
    for (const ex of sortedExons(data)) {
      const exLen = ex.end - ex.start;
      if (remainingStart < exLen) {
        const chunkStart = ex.start + remainingStart;
        const availableLen = exLen - remainingStart;
        const chunkLen = Math.min(remainingLen, availableLen);
        ranges.push({ start: chunkStart, end: chunkStart + chunkLen });
        remainingLen -= chunkLen;
        remainingStart = 0;
        if (remainingLen <= 0) break;
      } else {
        remainingStart -= exLen;
      }
    }
  }

  if (ranges.length === 0 && p.primerSeq && gene) {
    const clean = p.primerSeq.replace(/[^A-Za-z]/g, '').toUpperCase();
    const rc = reverseComplement(clean);
    const idx = gene.indexOf(clean);
    if (idx !== -1) ranges.push({ start: idx, end: idx + clean.length });
    const idxRC = gene.indexOf(rc);
    if (idxRC !== -1 && idxRC !== idx) ranges.push({ start: idxRC, end: idxRC + rc.length });
  }

  return ranges;
}

/**
 * The inverse direction: maps a genomic-space selection (`region` `'up'`/
 * `'down'`/`'gene'`) onto the spliced (intron-free) coordinate space, by
 * walking the same exon list and accumulating a running spliced offset.
 * `'spliced'`-region selections need no conversion — use `[p.start, p.end)`
 * directly.
 */
export function genomicToSpliced(p: Selection | null | undefined, data: SequenceData | null): Range[] {
  if (!p || !data || p.region === 'spliced') return [];

  let pStart = p.start;
  let pEnd = p.end;
  if (p.region === 'up') {
    const upLen = data.upstream_len || 0;
    pStart -= upLen;
    pEnd -= upLen;
  } else if (p.region === 'down') {
    const geneLen = data.gene_len || 0;
    pStart += geneLen;
    pEnd += geneLen;
  }

  const spans: Range[] = [];
  let splicedOffset = 0;
  for (const ex of sortedExons(data)) {
    const s = Math.max(pStart, ex.start);
    const e = Math.min(pEnd, ex.end);
    if (e > s) {
      spans.push({ start: splicedOffset + (s - ex.start), end: splicedOffset + (e - ex.start) });
    }
    splicedOffset += ex.end - ex.start;
  }
  return spans;
}
