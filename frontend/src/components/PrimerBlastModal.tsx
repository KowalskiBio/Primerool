import { useEffect, useState } from 'react';
import { getBlastBatchJob, startBlastBatch, type BlastHit } from '../api/blast';
import { SPECIES_BY_KINGDOM, KINGDOM_LABELS, type Kingdom } from '../utils/species';
import Modal from './ui/Modal';
import Select from './ui/Select';
import BlastResultsTable from './BlastResultsTable';

const POLL_MS = 3000;

interface Props {
  /** The primer to BLAST (5'->3'), or `null` to keep the modal closed. */
  primer: string | null;
  /** Names the primer in the title, e.g. "Forward primer". */
  label: string;
  /** Organism slug the search starts restricted to (changeable here). */
  organism: string;
  onClose: () => void;
}

/** BLASTs one primer for specificity: the short-oligo-tuned search (word
 * 11, no low-complexity filter, E<1000 - a plain megablast finds nothing
 * for an 18-30 nt query) restricted to one organism, via the same
 * `/blast_batch` job the SNP batch's BLAST check uses. Hits come back with
 * their alignments, each judged by where it mismatches (see
 * `BlastResultsTable`'s primer mode). */
export default function PrimerBlastModal({ primer, label, organism: initialOrganism, onClose }: Props) {
  const [organism, setOrganism] = useState(initialOrganism);
  const [hits, setHits] = useState<BlastHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which primer+organism `hits`/`error` belong to - see `BlastModal.tsx`.
  const [resultFor, setResultFor] = useState<string | null>(null);
  const runKey = primer ? `${primer}:${organism}` : null;
  const listed = Object.values(SPECIES_BY_KINGDOM).some((options) => options.some((s) => s.value === organism));

  // Seconds spent on the current run - a visible counter so a slow NCBI
  // queue reads as "waiting on NCBI", not a frozen modal (the server's
  // poll budget allows a job to legitimately sit in NCBI's WAITING queue
  // for minutes).
  const [elapsed, setElapsed] = useState(0);
  const doneForTimer = runKey !== null && resultFor === runKey;
  useEffect(() => {
    if (!runKey || doneForTimer) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(t);
  }, [runKey, doneForTimer]);

  useEffect(() => {
    if (!primer) return;
    let cancelled = false;
    const key = `${primer}:${organism}`;
    (async () => {
      try {
        const started = await startBlastBatch([{ id: 'primer', sequence: primer }], organism);
        let job = await getBlastBatchJob(started.job_id);
        while (job.status === 'running') {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          if (cancelled) return;
          job = await getBlastBatchJob(started.job_id);
        }
        if (cancelled) return;
        const result = job.results?.[0];
        if (job.status === 'error' || !result || result.status === 'error') throw new Error(job.error ?? result?.error ?? 'BLAST failed');
        setHits(result.hits ?? []);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setHits(null);
        setError(e instanceof Error ? e.message : String(e));
      }
      setResultFor(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [primer, organism]);

  const done = doneForTimer;

  return (
    <Modal open={primer !== null} onClose={onClose} title={primer ? `BLAST - ${label} (${primer.length} nt)` : ''}>
      {primer && (
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <p className="break-all font-mono text-xs text-ink">5′ {primer} 3′</p>
          <label className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            Organism:
            <Select size="sm" value={organism} onChange={(e) => setOrganism(e.target.value)} disabled={!done}>
              {!listed && <option value={organism}>{organism.replace(/_/g, ' ')}</option>}
              {(Object.keys(SPECIES_BY_KINGDOM) as Kingdom[]).map((k) => (
                <optgroup key={k} label={KINGDOM_LABELS[k]}>
                  {SPECIES_BY_KINGDOM[k]
                    .filter((s) => s.value !== '__custom__')
                    .map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </label>
        </div>
      )}
      {!done && (
        <p role="status" className="text-sm text-ink-muted">
          Running NCBI BLAST… {elapsed < 60 ? 'this usually takes 30 s to a few minutes' : "NCBI's queue is slow right now - still waiting"} ({elapsed} s).
        </p>
      )}
      {done && error && (
        <div role="alert" className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">
          {error}
        </div>
      )}
      {done && hits && primer && (hits.length === 0 ? <p className="text-sm text-ink-muted">No BLAST hits found in this organism.</p> : <BlastResultsTable hits={hits} primer={primer} />)}
    </Modal>
  );
}
