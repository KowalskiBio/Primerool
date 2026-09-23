import { useState } from 'react';
import type { SequenceData } from '../api/sequence';
import type { Selection, Selections } from '../utils/regionMapping';
import SequenceViewer from './SequenceViewer';
import SplicedSequenceViewer from './SplicedSequenceViewer';
import FeatureMap from './FeatureMap';
import Button from './ui/Button';

type PrimerMode = 'flanking' | 'junction' | 'general' | 'arms';

interface Props {
  data: SequenceData;
  selections: Selections;
  truncateIntrons: boolean;
  primerMode: PrimerMode;
  onPrimerModeChange: (mode: PrimerMode) => void;
  onClearSelections: () => void;
  /** Interactive drag/resize edits from `SequenceViewer` flow back up
   * through this - same callback shape as the design panels' `onSelect`. */
  onSelect?: (key: keyof Selections, value: Selection) => void;
}

export default function SequenceFeaturesPanel({ data, selections, truncateIntrons, primerMode, onPrimerModeChange, onClearSelections, onSelect }: Props) {
  const [showFeatureMap, setShowFeatureMap] = useState(false);
  const [showSplicedMap, setShowSplicedMap] = useState(false);

  const hasAnnotations = (data.annotations || []).length > 0;

  return (
    <div>
      {hasAnnotations && (
        <>
          {showFeatureMap && (
            <div className="mb-8">
              <FeatureMap key={`${data.transcript_id}-${data.gene_len}-${data.upstream_len}-${data.downstream_len}`} data={data} selections={selections} />
            </div>
          )}

          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Sequence map (for WGA / flanking primers)</h3>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setShowFeatureMap((v) => !v)}>
                Feature map
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setShowSplicedMap((v) => !v);
                  if (!showSplicedMap) onPrimerModeChange('junction');
                }}
              >
                Exon map
              </Button>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted">
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-ink-faint" /> Flanking regions
            </div>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-ink-muted" /> Introns
            </div>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-[var(--seq-utr-bg)]" /> UTR
            </div>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-[var(--seq-cds-bg)]" /> CDS
            </div>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-[var(--seq-primer-ink)]" /> Selected primer binding sites
            </div>
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-[var(--seq-probe-ink)]" /> Selected TaqMan probe
            </div>
          </div>
        </>
      )}

      <SequenceViewer data={data} selections={selections} truncateIntrons={truncateIntrons} onSelect={onSelect} />

      {primerMode === 'junction' && showSplicedMap && (
        <div className="mt-6">
          <SplicedSequenceViewer data={data} selections={selections} />
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClearSelections}>
          Clear Primer Highlights
        </Button>
      </div>
    </div>
  );
}
