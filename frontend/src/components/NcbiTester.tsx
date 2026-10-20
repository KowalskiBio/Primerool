import { useState } from 'react';
import { checkNcbiTestQueue, startNcbiTest, type NcbiCheck } from '../api/ncbiTest';
import Button from './ui/Button';

/** NCBI allows one status check per search per minute, so the queue is
 * checked once after this delay, in its own short request. */
const QUEUE_WAIT_MS = 60_000;

interface Results {
  eutils: NcbiCheck | null;
  blast_submit: NcbiCheck | null;
  blast_queue: NcbiCheck | null;
}

const ROWS: [keyof Results, string][] = [
  ['eutils', 'NCBI E-utilities'],
  ['blast_submit', 'BLAST submit'],
  ['blast_queue', 'BLAST queue'],
];

/** "Test NCBI" in Settings: is NCBI reachable, is the API key accepted,
 * and how backed up is the BLAST queue right now - so a slow or failing
 * BLAST can be told apart from a problem in Primerool. */
export default function NcbiTester({ apiKey }: { apiKey: string }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Results | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResults(null);
    try {
      const { eutils, blast_submit, rid } = await startNcbiTest(apiKey.trim());
      const partial = { eutils, blast_submit, blast_queue: null };
      setResults(partial);
      if (rid) {
        await new Promise((resolve) => setTimeout(resolve, QUEUE_WAIT_MS));
        setResults({ ...partial, blast_queue: await checkNcbiTestQueue(rid) });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={running} onClick={() => void run()}>
          {running ? 'Testing…' : 'Test NCBI'}
        </Button>
        <span className="text-xs text-ink-muted">
          {!running
            ? 'Checks the key and how long the BLAST queue takes.'
            : results
              ? 'Test search queued. NCBI allows one status check per minute, so this takes a minute.'
              : 'Checking E-utilities and submitting a tiny BLAST search.'}
        </span>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {results && (
        <ul className="space-y-1 text-xs">
          {ROWS.map(([key, label]) => {
            const check = results[key];
            return (
              <li key={key} className="flex gap-2">
                <span className={`w-3 shrink-0 font-semibold ${!check ? 'text-ink-faint' : check.ok ? 'text-success' : 'text-danger'}`}>{!check ? (running ? '…' : '·') : check.ok ? '✓' : '✗'}</span>
                <span className="w-32 shrink-0 font-medium text-ink">{label}</span>
                <span className="text-ink-muted">{check ? check.detail : running ? 'Waiting for NCBI…' : 'Skipped.'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
