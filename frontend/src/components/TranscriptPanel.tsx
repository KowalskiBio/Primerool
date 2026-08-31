import { useState } from 'react';
import { getSequence } from '../api/sequence';
import type { Transcript } from '../api/gene';
import type { SequenceData } from '../api/sequence';

interface Props {
  geneName: string;
  species: string;
  apiSource: 'ensembl' | 'ncbi';
  transcripts: Transcript[];
  truncateIntrons: boolean;
  onTruncateIntronsChange: (value: boolean) => void;
  onSequenceLoaded: (data: SequenceData) => void;
}

export default function TranscriptPanel({ geneName, species, apiSource, transcripts, truncateIntrons, onTruncateIntronsChange, onSequenceLoaded }: Props) {
  // Lazy initializer only — App.tsx remounts this component (via a `key`
  // tied to the gene/species/source) whenever a new `transcripts` list
  // arrives, so there's no need to react to prop changes after mount.
  const [transcriptId, setTranscriptId] = useState(() => transcripts.find((t) => t.is_canonical)?.id || transcripts[0]?.id || '');
  const [includeIntrons, setIncludeIntrons] = useState(false);
  const [includeUTR, setIncludeUTR] = useState(false);
  const [upFlank, setUpFlank] = useState(200);
  const [downFlank, setDownFlank] = useState(200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function showSequence() {
    if (!transcriptId) {
      setError('Please select a transcript first');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const data = await getSequence({
        gene_name: geneName,
        transcript_id: transcriptId,
        upstream_bp: upFlank,
        downstream_bp: downFlank,
        include_introns: includeIntrons,
        include_utr: includeUTR,
        species,
        api_source: apiSource,
      });
      onSequenceLoaded(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Transcript:</label>
      <select
        value={transcriptId}
        onChange={(e) => setTranscriptId(e.target.value)}
        className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm focus:border-green-500 focus:ring-green-500 text-sm px-3 py-2 border mb-6"
      >
        <option value="">-- Select a transcript --</option>
        {transcripts.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.is_canonical ? ' (Canonical)' : ''} ({t.exon_count} exons, strand {t.strand})
          </option>
        ))}
      </select>

      <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mt-6 mb-3 border-t border-slate-100 dark:border-slate-700 pt-4">Sequence Options</h3>

      <div className="space-y-3 mb-6">
        <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300">
          <input type="checkbox" checked={includeIntrons} onChange={(e) => setIncludeIntrons(e.target.checked)} className="accent-green-600 rounded w-4 h-4" />
          Include Introns (genomic DNA with introns/exons)
        </label>
        <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300">
          <input type="checkbox" checked={truncateIntrons} onChange={(e) => onTruncateIntronsChange(e.target.checked)} className="accent-green-600 rounded w-4 h-4" />
          Truncate Introns (show length only, for easier exon copying)
        </label>
        <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300">
          <input type="checkbox" checked={includeUTR} onChange={(e) => setIncludeUTR(e.target.checked)} className="accent-green-600 rounded w-4 h-4" />
          Include UTRs (untranslated regions)
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Upstream Flank (bp):</label>
          <input
            type="number"
            min={0}
            value={upFlank}
            onChange={(e) => setUpFlank(parseInt(e.target.value, 10) || 0)}
            onKeyDown={(e) => e.key === 'Enter' && void showSequence()}
            className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm focus:border-green-500 focus:ring-green-500 text-sm px-3 py-2 border"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Downstream Flank (bp):</label>
          <input
            type="number"
            min={0}
            value={downFlank}
            onChange={(e) => setDownFlank(parseInt(e.target.value, 10) || 0)}
            onKeyDown={(e) => e.key === 'Enter' && void showSequence()}
            className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm focus:border-green-500 focus:ring-green-500 text-sm px-3 py-2 border"
          />
        </div>
      </div>

      <button
        disabled={loading}
        onClick={() => void showSequence()}
        className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm"
      >
        {loading ? 'Loading…' : 'Show Sequence'}
      </button>

      {error && <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm font-medium">{error}</div>}
    </div>
  );
}
