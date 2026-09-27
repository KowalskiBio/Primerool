import { useEffect, useState } from 'react';
import { blastSequence, type BlastHit } from '../api/blast';
import Modal from './ui/Modal';
import BlastResultsTable from './BlastResultsTable';

interface Props {
  /** The sequence to BLAST, or `null` to keep the modal closed. */
  sequence: string | null;
  onClose: () => void;
}

/** BLASTs an arbitrary stretch (picked from the sequence map's right-click
 * menu) against NCBI and lists the top hits - the same `/blast_sequence`
 * route and results table as `InputPanel.tsx`'s "Identify Sequence". */
export default function BlastModal({ sequence, onClose }: Props) {
  const [hits, setHits] = useState<BlastHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which sequence `hits`/`error` belong to - see `PrimerStructurePanel.tsx`'s
  // `resultFor` for the same pattern.
  const [resultFor, setResultFor] = useState<string | null>(null);

  useEffect(() => {
    if (!sequence) return;
    let cancelled = false;
    blastSequence(sequence).then(
      (res) => {
        if (cancelled) return;
        setHits(res.hits || []);
        setError(null);
        setResultFor(sequence);
      },
      (e) => {
        if (cancelled) return;
        setHits(null);
        setError(e instanceof Error ? e.message : String(e));
        setResultFor(sequence);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sequence]);

  const done = sequence !== null && resultFor === sequence;

  return (
    <Modal open={sequence !== null} onClose={onClose} title={sequence ? `BLAST - ${sequence.length} bp selection` : ''}>
      {sequence && <p className="mb-3 break-all font-mono text-xs text-ink">{sequence}</p>}
      {!done && (
        <p role="status" className="text-sm text-ink-muted">
          Running NCBI BLAST… this can take up to 2 minutes.
        </p>
      )}
      {done && error && (
        <div role="alert" className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">
          {error}
        </div>
      )}
      {done && hits && (hits.length === 0 ? <p className="text-sm text-ink-muted">No BLAST hits found.</p> : <BlastResultsTable hits={hits} />)}
    </Modal>
  );
}
