import { useState, type ReactNode } from 'react';
import type { SequenceData } from '../api/sequence';

/** Where a hovered base sits: the region its `data-pos` is local to, and
 * that 0-based local index. `region` is whatever the rendering component
 * wrote into `data-region` - `'up'`/`'gene'`/`'down'` for `SequenceViewer`,
 * `'spliced'` for `SplicedSequenceViewer`. `variantRsid` is the hovered
 * span's `data-variant-rsid`, when the rendering component marks SNP
 * bases that way (`SequenceViewer` does) - lets the tooltip's `describe`
 * name the variant under the pointer. */
export interface HoveredBase {
  region: string;
  pos: number;
  base: string;
  variantRsid?: string;
}

interface Tip {
  x: number;
  y: number;
  lines: string[];
}

/** The text node and insertion offset under a point, or `null` - the
 * caret APIs return the nearest insertion point (between characters, and
 * even from blank space past a short row's end). */
function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** Finds the single character under the pointer, if any, in a text node
 * whose parent span carries `data-region`/`data-pos`. The caret APIs return
 * the nearest *insertion point* (between characters, and even from blank
 * space past a short row's end), so both neighbouring characters are
 * checked against the actual pointer position rather than trusting it.
 * Exported for the sequence map's primer drag, which follows the base
 * under the pointer. */
export function baseAtPoint(x: number, y: number): HoveredBase | null {
  const caret = caretAtPoint(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null;
  const span = caret.node.parentElement;
  const region = span?.dataset.region;
  const posAttr = span?.dataset.pos;
  if (!span || !region || posAttr === undefined) return null;
  const text = caret.node.textContent ?? '';
  const range = document.createRange();
  for (const i of [caret.offset, caret.offset - 1]) {
    if (i < 0 || i >= text.length) continue;
    range.setStart(caret.node, i);
    range.setEnd(caret.node, i + 1);
    const r = range.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
      const rsid = span.dataset.variantRsid;
      return { region, pos: Number(posAttr) + i, base: text[i], variantRsid: rsid || undefined };
    }
  }
  return null;
}

/** Hover-to-read-position for a sequence map. Every character span that
 * should report a position needs `data-region` and `data-pos` (the
 * 0-based local index of its first character); spread `handlers` onto the
 * scrolling container and render `tooltip` anywhere inside the component.
 * `describe` turns a hovered base into the tooltip's lines, or `null` to
 * show nothing. `enabled: false` (e.g. mid-drag) hides it. */
export function useBaseHover(describe: (b: HoveredBase) => string[] | null, enabled = true) {
  const [tip, setTip] = useState<Tip | null>(null);

  const handlers = {
    onMouseMove: (e: React.MouseEvent) => {
      const hit = enabled ? baseAtPoint(e.clientX, e.clientY) : null;
      const lines = hit ? describe(hit) : null;
      setTip(lines ? { x: e.clientX, y: e.clientY, lines } : null);
    },
    onMouseLeave: () => setTip(null),
  };

  const tooltip: ReactNode =
    tip && enabled ? (
      <div
        role="tooltip"
        className="pointer-events-none fixed z-[60] rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs text-ink shadow-lg"
        style={{ left: tip.x + 14, top: tip.y + 16 }}
      >
        {tip.lines.map((l, i) => (
          <div key={i} className={i === 0 ? 'font-semibold' : 'text-ink-muted'}>
            {l}
          </div>
        ))}
      </div>
    ) : null;

  return { handlers, tooltip };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Genomic coordinate of `local` (0-based, in `gene_seq` coordinates,
 * negative into the upstream flank, >= gene_len into the downstream one) -
 * same formula as `utils/variantMapping.ts`, inverted. Only meaningful when
 * `gene_seq` is the linear genomic template (`include_introns`) and the
 * sequence actually came from a genome (a pasted custom sequence has no
 * coordinates). */
export function genomicPosition(data: SequenceData, local: number): number | null {
  if (!data.include_introns || !data.gene_start_genomic || !data.chrom) return null;
  return data.strand === '-' ? data.gene_end_genomic - local : data.gene_start_genomic + local;
}

/** Tooltip lines for a base at `local` (0-based `gene_seq` coordinates,
 * negative/past-the-end into the flanks): its 1-based position from the
 * start of the gene (no position 0 - the base just before the gene is -1),
 * then its genomic coordinate when there is one. */
export function describeGenePosition(data: SequenceData, local: number, base: string, extra?: string): string[] {
  const genePos = local >= 0 ? local + 1 : local;
  const where = local < 0 ? 'upstream' : local >= data.gene_len ? 'downstream' : null;
  const lines = [`${base.toUpperCase()} · position ${fmt(genePos)}${where ? ` (${where})` : ''}`];
  if (extra) lines.push(extra);
  const g = genomicPosition(data, local);
  if (g !== null) lines.push(`${data.chrom.startsWith('chr') ? '' : 'chr'}${data.chrom}:${fmt(g)}`);
  return lines;
}
