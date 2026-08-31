import { useState } from 'react';
import type { SequenceData } from '../api/sequence';
import type { Selection, Selections } from '../utils/regionMapping';
import SequenceViewer from './SequenceViewer';
import SplicedSequenceViewer from './SplicedSequenceViewer';
import FeatureMap from './FeatureMap';
import SelectedPrimerInfo from './SelectedPrimerInfo';
import type { IdtCredentials } from './IdtSettingsPanel';

type PrimerMode = 'flanking' | 'junction' | 'general' | 'arms';

interface Props {
  data: SequenceData;
  selections: Selections;
  truncateIntrons: boolean;
  primerMode: PrimerMode;
  onPrimerModeChange: (mode: PrimerMode) => void;
  onClearSelections: () => void;
  ampTarget: number | null;
  ampDev: number | null;
  onFindProbesInAmplicon?: () => void;
  idtCredentials?: IdtCredentials;
  /** Interactive drag/resize edits from `SequenceViewer` flow back up
   * through this — same callback shape as the design panels' `onSelect`. */
  onSelect?: (key: keyof Selections, value: Selection) => void;
}

export default function SequenceFeaturesPanel({ data, selections, truncateIntrons, primerMode, onPrimerModeChange, onClearSelections, ampTarget, ampDev, onFindProbesInAmplicon, idtCredentials, onSelect }: Props) {
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

          <div className="flex items-center justify-between mb-2">
            <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200">Sequence map (for WGA / flanking primers)</h3>
            <div className="flex gap-2">
              <button
                onClick={() => setShowFeatureMap((v) => !v)}
                className="px-4 py-2 text-sm font-medium bg-green-600 border border-green-600 rounded hover:bg-green-700 text-white transition-colors shadow-sm"
              >
                Feature map
              </button>
              <button
                onClick={() => {
                  setShowSplicedMap((v) => !v);
                  if (!showSplicedMap) onPrimerModeChange('junction');
                }}
                className="px-4 py-2 text-sm font-medium bg-green-600 border border-green-600 rounded hover:bg-green-700 text-white transition-colors shadow-sm"
              >
                Exon map
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-4 text-sm mb-4 bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-700 text-slate-600 dark:text-slate-300">
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400">■</span> Flanking regions
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500">■</span> Introns
            </div>
            <div className="flex items-center gap-1.5">
              <span className="px-1 bg-orange-200 text-slate-900 rounded">&nbsp;</span> UTR
            </div>
            <div className="flex items-center gap-1.5">
              <strong className="px-1 bg-orange-200 text-slate-900 rounded">■</strong> CDS
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-red-600 dark:text-red-400">■</span> Selected primer binding sites
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-blue-600 dark:text-blue-400">■</span> Selected TaqMan probe
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
        <button
          onClick={onClearSelections}
          className="text-sm text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 font-medium px-3 py-1.5 rounded border border-slate-200 dark:border-slate-700 hover:border-red-200 dark:hover:border-red-900 bg-white dark:bg-slate-800 shadow-sm transition-colors"
        >
          Clear Primer Highlights
        </button>
      </div>

      <SelectedPrimerInfo selections={selections} data={data} ampTarget={ampTarget} ampDev={ampDev} onFindProbesInAmplicon={onFindProbesInAmplicon} idtCredentials={idtCredentials} />
    </div>
  );
}
