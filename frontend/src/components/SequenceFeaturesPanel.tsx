import { useMemo, useState } from 'react';
import { useSessionState } from '../session/sessionContext';
import type { SequenceData } from '../api/sequence';
import type { Selection, Selections } from '../utils/regionMapping';
import SequenceViewer from './SequenceViewer';
import SplicedSequenceViewer from './SplicedSequenceViewer';
import FeatureMap from './FeatureMap';
import PrimerSetsPanel from './PrimerSetsPanel';
import type { IdtCredentials } from '../utils/idtCredentials';
import Button from './ui/Button';
import SegmentedControl from './ui/SegmentedControl';
import { isPlusOriented } from '../utils/orientation';
import { flipSelection, flipSelections, flipSequenceData } from '../utils/strandFlip';

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
  onSelect?: (key: keyof Selections, value: Selection | null) => void;
  /** Forwarded to `SequenceViewer` so its "Find in sequence" can resolve
   * rsID queries against the catalog `data` was fetched from - pass
   * nothing for a custom pasted sequence (nothing to resolve against). */
  species?: string;
  apiSource?: string;
  /** The organism currently selected in the input panel's toggle -
   * forwarded to `SequenceViewer` as an rsID-lookup fallback. */
  selectedSpecies?: string;
  /** Complete IDT credentials, or undefined - enables the primer sets'
   * "IDT" Tm button. */
  idtCredentials?: IdtCredentials;
}

export default function SequenceFeaturesPanel({ data, selections, truncateIntrons, primerMode, onPrimerModeChange, onClearSelections, onSelect, species, apiSource, selectedSpecies, idtCredentials }: Props) {
  const [showFeatureMap, setShowFeatureMap] = useSessionState('features.showFeatureMap', false);
  const [showSplicedMap, setShowSplicedMap] = useSessionState('features.showSplicedMap', false);

  const hasAnnotations = (data.annotations || []).length > 0;

  // The strand the maps (feature, sequence and exon map) are drawn on.
  // Always the genomic plus strand by default; a minus-strand gene can be
  // switched to its own (minus) strand, where the mRNA reads left to
  // right. Remembered as the `data` it was chosen for, so loading another
  // sequence falls back to plus. Only the maps flip - selections are
  // stored in `data`'s own coordinates and are translated into and out of
  // the flipped view.
  const [minusFor, setMinusFor] = useState<SequenceData | null>(null);
  const canFlip = data.strand === '-' && data.transcript_id !== 'custom';
  const mapStrand: '+' | '-' = canFlip && minusFor === data ? '-' : '+';
  const flipped = canFlip && isPlusOriented(data) !== (mapStrand === '+');
  const mapData = useMemo(() => (flipped ? flipSequenceData(data) : data), [flipped, data]);
  const mapSelections = useMemo(() => (flipped ? flipSelections(selections, data) : selections), [flipped, selections, data]);
  const mapOnSelect = useMemo(
    () => (flipped && onSelect ? (key: keyof Selections, value: Selection | null) => onSelect(key, value && flipSelection(value, mapData)) : onSelect),
    [flipped, onSelect, mapData],
  );

  return (
    <div>
      {hasAnnotations && (
        <>
          {showFeatureMap && (
            <div className="mb-8">
              <FeatureMap key={`${data.transcript_id}-${data.gene_len}-${data.upstream_len}-${data.downstream_len}-${mapStrand}`} data={mapData} selections={mapSelections} />
            </div>
          )}

          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Sequence map (for WGA / flanking primers)</h3>
            <div className="flex flex-wrap items-center gap-2">
              {canFlip && (
                <SegmentedControl
                  size="sm"
                  ariaLabel="Strand shown on the maps"
                  value={mapStrand}
                  onChange={(v) => setMinusFor(v === '-' ? data : null)}
                  options={[
                    { value: '+', label: '+ strand', title: 'Show the maps on the genomic plus strand' },
                    { value: '-', label: '− strand', title: `Show the maps on the minus strand, where ${data.gene_name} is - its mRNA reads left to right` },
                  ]}
                />
              )}
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

      {/* Remounted on a strand switch, so in-map state held in map
          coordinates (an alignment hit, a drag) is recomputed rather than
          misplaced; the search queries themselves are session state and
          survive. */}
      <SequenceViewer
        key={mapStrand}
        persistKey="viewer.main"
        data={mapData}
        selections={mapSelections}
        truncateIntrons={truncateIntrons}
        onSelect={mapOnSelect}
        species={species}
        apiSource={apiSource}
        selectedSpecies={selectedSpecies}
      />

      {primerMode === 'junction' && showSplicedMap && (
        <div className="mt-6">
          <SplicedSequenceViewer key={mapStrand} data={mapData} selections={mapSelections} onSelect={mapOnSelect} onHide={() => setShowSplicedMap(false)} />
        </div>
      )}

      {onSelect && <PrimerSetsPanel data={data} selections={selections} onSelect={onSelect} idtCredentials={idtCredentials} />}

      <div className="mt-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClearSelections}>
          Clear Primer Highlights
        </Button>
      </div>
    </div>
  );
}
