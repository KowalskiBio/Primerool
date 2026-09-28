import { useState } from 'react';
import { useSessionState } from '../session/sessionContext';
import { getSequence } from '../api/sequence';
import type { Transcript } from '../api/gene';
import type { SequenceData } from '../api/sequence';
import Field from './ui/Field';
import TextInput from './ui/TextInput';
import Select from './ui/Select';
import Checkbox from './ui/Checkbox';
import Button from './ui/Button';

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
  // Lazy initializer only - App.tsx remounts this component (via a `key`
  // tied to the gene/species/source) whenever a new `transcripts` list
  // arrives, so there's no need to react to prop changes after mount.
  const [transcriptId, setTranscriptId] = useSessionState('transcript.transcriptId', () => transcripts.find((t) => t.is_canonical)?.id || transcripts[0]?.id || '');
  const [includeIntrons, setIncludeIntrons] = useSessionState('transcript.includeIntrons', true);
  const [includeUTR, setIncludeUTR] = useSessionState('transcript.includeUTR', false);
  const [upFlank, setUpFlank] = useSessionState('transcript.upFlank', 200);
  const [downFlank, setDownFlank] = useSessionState('transcript.downFlank', 200);
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
        orient_plus: true,
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
      {/* One wrapping row: transcript and flank sizes - fits on one line on
          a wide screen, wraps on a narrow one. */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field label="Transcript" htmlFor="transcript-select" className="min-w-[18rem] flex-1">
          <Select id="transcript-select" value={transcriptId} onChange={(e) => setTranscriptId(e.target.value)}>
            <option value="">Select a transcript…</option>
            {transcripts.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.is_canonical ? ' (Canonical)' : ''} ({t.exon_count} exons, strand {t.strand})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Upstream Flank (bp)" className="w-36">
          <TextInput
            type="number"
            min={0}
            value={upFlank}
            onChange={(e) => setUpFlank(parseInt(e.target.value, 10) || 0)}
            onKeyDown={(e) => e.key === 'Enter' && void showSequence()}
            className="tabular-nums"
          />
        </Field>
        <Field label="Downstream Flank (bp)" className="w-36">
          <TextInput
            type="number"
            min={0}
            value={downFlank}
            onChange={(e) => setDownFlank(parseInt(e.target.value, 10) || 0)}
            onKeyDown={(e) => e.key === 'Enter' && void showSequence()}
            className="tabular-nums"
          />
        </Field>
      </div>

      <h3 className="mb-3 mt-5 border-t border-line pt-4 text-sm font-semibold text-ink">Sequence Options</h3>

      {/* One wrapping row with real gaps (`Checkbox` is inline-flex, so
          without an explicit flex gap the labels run into each other), the
          action at its end. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Checkbox label="Include Introns (genomic DNA with introns/exons)" checked={includeIntrons} onChange={(e) => setIncludeIntrons(e.target.checked)} />
        <Checkbox label="Truncate Introns (show length only, for easier exon copying)" checked={truncateIntrons} onChange={(e) => onTruncateIntronsChange(e.target.checked)} />
        <Checkbox label="Include UTRs (untranslated regions)" checked={includeUTR} onChange={(e) => setIncludeUTR(e.target.checked)} />
        <Button variant="primary" className="ml-auto" disabled={loading} onClick={() => void showSequence()}>
          {loading ? 'Loading…' : 'Show Sequence'}
        </Button>
      </div>

      {error && <div role="alert" className="mt-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{error}</div>}
    </div>
  );
}
