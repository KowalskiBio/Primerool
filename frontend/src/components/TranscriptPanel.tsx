import { useState } from 'react';
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
      <Field label="Transcript" htmlFor="transcript-select">
        <Select
          id="transcript-select"
          value={transcriptId}
          onChange={(e) => setTranscriptId(e.target.value)}
          className="mb-6"
        >
          <option value="">Select a transcript…</option>
          {transcripts.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.is_canonical ? ' (Canonical)' : ''} ({t.exon_count} exons, strand {t.strand})
            </option>
          ))}
        </Select>
      </Field>

      <h3 className="mb-3 border-t border-line pt-4 text-sm font-semibold text-ink">Sequence Options</h3>

      <div className="mb-6 space-y-3">
        <Checkbox label="Include Introns (genomic DNA with introns/exons)" checked={includeIntrons} onChange={(e) => setIncludeIntrons(e.target.checked)} />
        <Checkbox label="Truncate Introns (show length only, for easier exon copying)" checked={truncateIntrons} onChange={(e) => onTruncateIntronsChange(e.target.checked)} />
        <Checkbox label="Include UTRs (untranslated regions)" checked={includeUTR} onChange={(e) => setIncludeUTR(e.target.checked)} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Upstream Flank (bp)">
          <TextInput
            type="number"
            min={0}
            value={upFlank}
            onChange={(e) => setUpFlank(parseInt(e.target.value, 10) || 0)}
            onKeyDown={(e) => e.key === 'Enter' && void showSequence()}
            className="tabular-nums"
          />
        </Field>
        <Field label="Downstream Flank (bp)">
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

      <Button variant="primary" disabled={loading} onClick={() => void showSequence()}>
        {loading ? 'Loading…' : 'Show Sequence'}
      </Button>

      {error && <div role="alert" className="mt-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{error}</div>}
    </div>
  );
}
