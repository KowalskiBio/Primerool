import { useMemo } from 'react';
import type { SequenceData } from '../api/sequence';
import type { Selection, Selections } from '../utils/regionMapping';
import { genomicToSpliced } from '../utils/regionMapping';

interface Span {
  start: number;
  end: number;
  className: string;
}

interface Piece {
  kind: 'label' | 'text';
  text: string;
  className?: string;
}

function collectSplicedSpans(data: SequenceData, sel: Selections): Span[] {
  const spans: Span[] = [];
  const addDirect = (p: Selection | null, className: string) => {
    if (p && p.region === 'spliced') spans.push({ start: p.start, end: p.end, className });
  };
  addDirect(sel.juncLeft, 'seq-primer');
  addDirect(sel.juncRight, 'seq-primer');

  const addMapped = (p: Selection | null, className: string) => {
    for (const r of genomicToSpliced(p, data)) spans.push({ ...r, className });
  };
  addMapped(sel.geneForward, 'seq-primer');
  addMapped(sel.geneReverse, 'seq-primer');
  addMapped(sel.geneProbe, 'seq-probe');
  addMapped(sel.wgaForward, 'seq-primer');
  addMapped(sel.wgaReverse, 'seq-primer');
  addMapped(sel.armsRefPrimer, 'seq-primer');
  addMapped(sel.armsAltPrimer, 'seq-primer');
  addMapped(sel.armsCommon, 'seq-primer');

  return spans.sort((a, b) => a.start - b.start);
}

function sliceWithHighlights(spliced: string, a: number, b: number, spans: Span[]): Piece[] {
  const relevant = spans.filter((sp) => sp.end > a && sp.start < b).sort((x, y) => x.start - y.start);
  const pieces: Piece[] = [];
  let cur = a;
  for (const sp of relevant) {
    const s = Math.max(a, sp.start);
    const e = Math.min(b, sp.end);
    if (s > cur) pieces.push({ kind: 'text', text: spliced.substring(cur, s) });
    if (e > s) {
      pieces.push({ kind: 'text', text: spliced.substring(s, e), className: sp.className });
      cur = e;
    }
  }
  if (cur < b) pieces.push({ kind: 'text', text: spliced.substring(cur, b) });
  return pieces;
}

interface Props {
  data: SequenceData;
  selections: Selections;
}

export default function SplicedSequenceViewer({ data, selections }: Props) {
  const pieces = useMemo(() => {
    const spliced = data.spliced_exons_seq || '';
    const spans = collectSplicedSpans(data, selections);
    const jPos = (data.junctions || [])
      .map((j) => j.pos)
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);

    const out: Piece[] = [];
    let last = 0;
    let exonNum = 1;
    for (const jp of jPos) {
      const a = last;
      const b = Math.min(jp, spliced.length);
      out.push({ kind: 'label', text: `Exon ${exonNum} (${b - a} bp)` });
      out.push(...sliceWithHighlights(spliced, a, b, spans));
      exonNum++;
      last = b;
    }
    if (last < spliced.length) {
      out.push({ kind: 'label', text: `Exon ${exonNum} (${spliced.length - last} bp)` });
      out.push(...sliceWithHighlights(spliced, last, spliced.length, spans));
    }
    return out;
  }, [data, selections]);

  return (
    <div>
      <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mb-2">Spliced exon-only map (for exon–exon junction primers)</h3>
      <div className="text-sm text-slate-500 dark:text-slate-400 mb-3 bg-blue-50 dark:bg-blue-950/40 p-2 rounded border border-blue-100 dark:border-blue-900">
        Junction positions in the sequence map refer to these sequences. Horizontal bars indicate exon boundaries.
      </div>
      <div className="sequence-viewer bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-4 text-sm overflow-y-auto max-h-[520px] text-slate-800 dark:text-slate-200">
        {pieces.map((p, i) =>
          p.kind === 'label' ? (
            <span key={i} className="exon-label">
              {p.text}
            </span>
          ) : (
            <span key={i} className={p.className}>
              {p.text}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
