import { useState } from 'react';
import { blastSequence, type BlastHit } from '../api/blast';
import { ApiError } from '../api/client';
import { useBlastProgress } from '../utils/useBlastProgress';
import BlastProgress from './BlastProgress';
import BlastResultsTable from './BlastResultsTable';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
import { controlClasses } from './ui/TextInput';

interface Props {
  /** The server's explanation of what was searched and not found. */
  message: string;
  /** The selected organism as the server takes it (species slug, NCBI
   * Taxonomy ID or name) - the BLAST restriction - and as shown. */
  species: string;
  organismLabel: string;
  /** Loads a picked hit's region as the gene. */
  onUse: (hit: BlastHit) => void;
}

/** Shown under the gene search when the gene/organism pair isn't found:
 * says so, and offers to BLAST the gene's own sequence instead - by
 * default only against the selected organism. */
export default function GeneNotFoundPanel({ message, species, organismLabel, onUse }: Props) {
  const [sequence, setSequence] = useState('');
  const [onlyOrganism, setOnlyOrganism] = useState(true);
  const [running, setRunning] = useState(false);
  const [hits, setHits] = useState<BlastHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blastProgress = useBlastProgress();

  const seqLen = sequence.replace(/^>.*$/gm, '').replace(/\s/g, '').length;

  async function runBlast() {
    setError(null);
    setHits(null);
    if (seqLen < 20) {
      setError('Paste a sequence of at least 20 bp.');
      return;
    }
    setRunning(true);
    blastProgress.start();
    try {
      const data = await blastSequence(sequence, onlyOrganism ? species : undefined);
      setHits(data.hits || []);
    } catch (e) {
      // 404 = BLAST ran and matched nothing.
      if (e instanceof ApiError && e.status === 404) setHits([]);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      blastProgress.finish();
      setRunning(false);
    }
  }

  return (
    <div className="mt-4 rounded-md border border-warning/25 bg-warning-subtle px-4 py-3">
      <p role="alert" className="text-sm font-medium text-warning">
        {message}
      </p>

      <label htmlFor="not-found-sequence" className="mt-3 block text-sm text-ink">
        Have the gene&rsquo;s sequence? Paste it (raw or FASTA) to find it by BLAST:
      </label>
      <textarea
        id="not-found-sequence"
        rows={4}
        spellCheck={false}
        value={sequence}
        onChange={(e) => setSequence(e.target.value)}
        placeholder={'>my_gene\nATGCGTACGATCGATCGATCGATCG…'}
        className={`${controlClasses} mt-1.5 font-mono leading-relaxed resize-y`}
      />
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="primary" disabled={running} onClick={() => void runBlast()}>
          {running ? 'Running BLAST…' : 'BLAST sequence'}
        </Button>
        <Checkbox
          id="not-found-only-organism"
          checked={onlyOrganism}
          onChange={(e) => setOnlyOrganism(e.target.checked)}
          disabled={running || !species}
          label={
            <>
              Only search <em>{organismLabel || 'the selected organism'}</em>
            </>
          }
        />
      </div>

      <p className="mt-2 text-xs text-ink-muted">
        A gene described in a paper may not be in this strain at all - untick the organism
        filter to find which genomes carry it, then pick one of those as the reference.
      </p>

      {running && <BlastProgress progress={blastProgress.progress} />}
      {error && <div role="alert" className="mt-3 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{error}</div>}

      {hits && (
        <div className="mt-4 rounded-md border border-line bg-surface">
          <h3 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">
            BLAST Results <span className="font-normal text-ink-muted">({hits.length} hit{hits.length === 1 ? '' : 's'}{onlyOrganism ? ` in ${organismLabel}` : ''})</span>
          </h3>
          {hits.length ? (
            <BlastResultsTable hits={hits} onUse={onUse} />
          ) : (
            <p className="px-4 py-3 text-sm text-ink-muted">No significant matches{onlyOrganism ? ' in this organism - try unticking the organism filter' : ''}.</p>
          )}
        </div>
      )}
    </div>
  );
}
