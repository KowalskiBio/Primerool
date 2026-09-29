import type { SequenceData } from '../api/sequence';
import { reverseComplement } from './dna';
import { isPlusOriented } from './orientation';
import { selectionStrand, type Selection, type Selections } from './regionMapping';

/** Viewing a loaded sequence on its other strand - the sequence map's
 * +/- toggle. Everything here is an exact involution on the same genomic
 * span: the whole `upstream + gene + downstream` template is reverse-
 * complemented, so the old downstream flank becomes the new upstream one
 * and every `[start, end)` range is mirrored. The flipped data's
 * `plus_oriented` is inverted, so all coordinate math keyed off
 * `isPlusOriented` (genomic positions, SNP placement, allele orientation)
 * keeps working unchanged on the flipped view. */

const COMPLEMENT: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };
const complement = (b: string) => COMPLEMENT[b.toUpperCase()] ?? b;

const mirror = (start: number, end: number, len: number) => ({ start: len - end, end: len - start });

/** `data` on its other strand. Junctions are renumbered left to right, the
 * way `/get_sequence` numbers them in either orientation. */
export function flipSequenceData(data: SequenceData): SequenceData {
  const geneLen = data.gene_len;
  const splicedLen = (data.spliced_exons_seq || '').length;
  const annotations = (data.annotations || [])
    .map((a) => ({ ...a, ...mirror(a.start, a.end, geneLen) }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.start - b.start);
  const junctions = (data.junctions || [])
    .map((j) => splicedLen - j.pos)
    .sort((a, b) => a - b)
    .map((pos, i) => ({ index: i, pos, label: `Exon ${i + 1}|${i + 2}` }));
  return {
    ...data,
    upstream_seq: reverseComplement(data.downstream_seq),
    downstream_seq: reverseComplement(data.upstream_seq),
    upstream_len: data.downstream_len,
    downstream_len: data.upstream_len,
    gene_seq: reverseComplement(data.gene_seq),
    spliced_seq: reverseComplement(data.spliced_seq || ''),
    spliced_exons_seq: reverseComplement(data.spliced_exons_seq || ''),
    annotations,
    junctions,
    plus_oriented: !isPlusOriented(data),
  };
}

/** `sel` (in `data`'s coordinates) re-expressed on the flipped view. The
 * oligo itself (`primerSeq`) never changes - only the template it's drawn
 * against - so a forward primer becomes a reverse one and vice versa.
 * Flip back by passing the flipped data as `data`. */
export function flipSelection(sel: Selection, data: SequenceData): Selection {
  const geneLen = data.gene_len;
  const flipSnp = <T extends { snpPos: number; wtBase: string; mutBase: string }>(s: T): T => ({
    ...s,
    snpPos: geneLen - 1 - s.snpPos,
    wtBase: complement(s.wtBase),
    mutBase: complement(s.mutBase),
  });
  const span =
    sel.region === 'up'
      ? { region: 'down' as const, ...mirror(sel.start, sel.end, data.upstream_len) }
      : sel.region === 'down'
        ? { region: 'up' as const, ...mirror(sel.start, sel.end, data.downstream_len) }
        : { region: sel.region, ...mirror(sel.start, sel.end, sel.region === 'gene' ? geneLen : (data.spliced_exons_seq || '').length) };
  return {
    ...sel,
    ...span,
    bindingSeq: reverseComplement(sel.bindingSeq),
    strand: selectionStrand(sel) === 'F' ? 'R' : 'F',
    ...(sel.arms ? { arms: flipSnp(sel.arms) } : {}),
    ...(sel.allele ? { allele: flipSnp(sel.allele) } : {}),
  };
}

export function flipSelections(selections: Selections, data: SequenceData): Selections {
  const out = { ...selections };
  for (const key of Object.keys(out) as (keyof Selections)[]) {
    const sel = out[key];
    if (sel) out[key] = flipSelection(sel, data);
  }
  return out;
}
