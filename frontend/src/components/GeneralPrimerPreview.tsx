import { useEffect, useMemo } from 'react';
import type { SequenceData } from '../api/sequence';
import type { GeneralPairResult } from '../api/design';
import { EMPTY_SELECTIONS, type Selections } from '../utils/regionMapping';
import { generalSelection } from '../utils/generalSelection';
import { fmt } from '../utils/format';
import Modal from './ui/Modal';
import Badge from './ui/Badge';
import SequenceViewer from './SequenceViewer';

interface Props {
  data: SequenceData;
  /** The pair and which of its primers is previewed; `null` closes. */
  preview: { pair: GeneralPairResult; side: 'left' | 'right' } | null;
  truncateIntrons: boolean;
  onClose: () => void;
}

/** Where a candidate primer would land, without selecting it: the
 * sequence map with the pair drawn on it, scrolled to the previewed
 * primer. Closed by the X, Escape, or a click outside the dialog. */
export default function GeneralPrimerPreview({ data, preview, truncateIntrons, onClose }: Props) {
  const key: keyof Selections = preview?.side === 'right' ? 'geneReverse' : 'geneForward';
  const selections = useMemo<Selections>(() => {
    if (!preview) return EMPTY_SELECTIONS;
    const { pair } = preview;
    return {
      ...EMPTY_SELECTIONS,
      geneForward: generalSelection(data, 'left', pair.left.interval, pair.left.sequence),
      geneReverse: generalSelection(data, 'right', pair.right.interval, pair.right.sequence),
    };
  }, [data, preview]);

  // Lands on the previewed primer. The map measures its line width after
  // mounting and reflows, so one early scroll ends up somewhere else:
  // repeat it until the primer holds still. Scoped to the dialog, since
  // the page's own map carries the same `data-pick-key`s.
  useEffect(() => {
    if (!preview) return;
    let frame = 0;
    let lastTop: number | null = null;
    let steady = 0;
    const tick = () => {
      const el = document.querySelector(`[role="dialog"] [data-pick-key="${key}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        const top = el.getBoundingClientRect().top;
        steady = lastTop !== null && Math.abs(top - lastTop) < 1 ? steady + 1 : 0;
        lastTop = top;
      }
      if (steady < 3 && ++frame < 60) id = requestAnimationFrame(tick);
    };
    let id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [preview, key]);

  const primer = preview ? preview.pair[preview.side] : null;
  const sideLabel = preview?.side === 'right' ? 'Reverse' : 'Forward';
  const title = preview && primer && (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{sideLabel} primer preview</span>
      <span className="font-mono text-xs font-normal text-ink-muted">{primer.sequence}</span>
      <span className="text-xs font-normal text-ink-muted">
        {primer.interval[0]}–{primer.interval[1]} · Tm {fmt(primer.tm)}&deg;C
      </span>
      <Badge tone="accent" title="Amplicon of this pair: forward primer through reverse primer">
        Amplicon {preview.pair.product_size} bp
      </Badge>
    </div>
  );

  return (
    <Modal open={preview !== null} onClose={onClose} title={title}>
      {preview && (
        <>
          <p className="mb-3 text-xs text-ink-muted">
            The pair's forward and reverse primers are drawn on the map. Nothing is selected until you click <strong className="font-medium text-ink">Use L</strong> or <strong className="font-medium text-ink">Use R</strong> in the results.
          </p>
          <SequenceViewer data={data} selections={selections} truncateIntrons={truncateIntrons} />
        </>
      )}
    </Modal>
  );
}
