import { useState } from 'react';
import { useSessionState } from '../session/sessionContext';
import { getHomologJob, startCollectHomologs, type Homolog, type HomologJob, type HomologSource } from '../api/homologs';
import { ApiError } from '../api/client';
import SegmentedControl from './ui/SegmentedControl';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
import Field from './ui/Field';
import TextInput from './ui/TextInput';
import { cleanDNA } from '../utils/dna';

const POLL_MS = 3000;
/** Times a job lost to a server restart is started again. */
const MAX_RESTARTS = 2;

interface Props {
  /** Used while the fields are left empty: the loaded gene and the
   * genus of its organism. */
  defaultGene?: string;
  defaultTaxon?: string;
  /** Adds the ticked homologs to the alignment input as FASTA. */
  onAdd: (fasta: string) => void;
  /** The records already in the alignment input: a homolog among them
   * (by name or sequence) isn't added twice. */
  existing: { id: string; seq: string }[];
}

/** "P. veronii CP012345.1": short enough for the alignment's name column
 * (it truncates at 20 characters), still telling species apart. */
function recordName(h: Homolog): string {
  const [genus, ...rest] = h.species.split(' ');
  return `${genus[0]}. ${rest.join(' ')} ${h.accession}`;
}

/** Whether a homolog matches the table's search: every word of `query`
 * found in its species, organism, strain, accession or protein. */
function matchesFilter(h: Homolog, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [h.species, h.organism, h.strain ?? '', h.accession, h.protein, h.gene].join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Collects one CDS of a gene per species within a taxon (from GenBank
 * proteins that record where they are coded), for a cross-species
 * alignment: the starting point for finding a conserved region. */
export default function HomologCollector({ defaultGene = '', defaultTaxon = '', onAdd, existing }: Props) {
  const [gene, setGene] = useSessionState('align.homologGene', '');
  const [taxon, setTaxon] = useSessionState('align.homologTaxon', '');
  const [maxSpecies, setMaxSpecies] = useSessionState('align.homologMax', 25);
  const [source, setSource] = useSessionState<HomologSource>('align.homologSource', 'eutils');
  const [via, setVia] = useSessionState<HomologJob['via'] | null>('align.homologVia', null);
  const [homologs, setHomologs] = useSessionState<Homolog[] | null>('align.homologs', null);
  const [ticked, setTicked] = useSessionState<string[]>('align.homologTicked', []);
  /** Narrows the found homologs' table; ticking all ticks only those shown. */
  const [filter, setFilter] = useSessionState('align.homologFilter', '');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** What the last "Add" did: how many went in, which were already there. */
  const [added, setAdded] = useState<{ count: number; already: string[] } | null>(null);

  async function collect() {
    const g = gene.trim() || defaultGene;
    const t = taxon.trim() || defaultTaxon;
    if (!g || !t) {
      setError('Enter a gene symbol and a taxon (a name like Pseudomonas, or a taxonomy ID like 286).');
      return;
    }
    setError(null);
    setAdded(null);
    setHomologs(null);
    setVia(null);
    setRunning(true);
    setElapsed(0);
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      let { job_id } = await startCollectHomologs(g, t, maxSpecies, source);
      let restarts = 0;
      let job: HomologJob = { status: 'running' };
      while (job.status === 'running') {
        try {
          job = await getHomologJob(job_id);
        } catch (e) {
          // Jobs live in server memory: a restart (a deploy) mid-run loses
          // this one - the poll 404s - so start it again; while the server
          // is still coming back the proxy answers 502-504, so keep polling.
          if (!(e instanceof ApiError)) throw e;
          if (e.status === 404 && restarts < MAX_RESTARTS) {
            restarts += 1;
            ({ job_id } = await startCollectHomologs(g, t, maxSpecies, source));
          } else if (e.status === 404) {
            throw new Error('The server restarted while collecting (an update going live). Try again in a moment.');
          } else if (e.status < 502 || e.status > 504) {
            throw e;
          }
        }
        if (job.status === 'running') await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      if (job.status === 'error') throw new Error(job.error || 'Collecting homologs failed.');
      const found = job.homologs ?? [];
      setHomologs(found);
      setVia(job.via ?? null);
      setTicked(found.map((h) => h.protein));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(tick);
      setRunning(false);
    }
  }

  const inputIds = new Set(existing.map((r) => r.id));
  const inputSeqs = new Set(existing.map((r) => r.seq));
  const alreadyIn = (h: Homolog) => inputIds.has(recordName(h)) || inputSeqs.has(cleanDNA(h.sequence));

  /** Appends the ticked homologs not yet in the input. */
  function add() {
    const chosen = (homologs ?? []).filter((h) => ticked.includes(h.protein));
    const fresh = chosen.filter((h) => !alreadyIn(h));
    setAdded({ count: fresh.length, already: chosen.filter(alreadyIn).map(recordName) });
    if (fresh.length > 0) onAdd(fresh.map((h) => `>${recordName(h)}\n${h.sequence}`).join('\n'));
  }

  const toggle = (protein: string, on: boolean) => setTicked(on ? [...ticked, protein] : ticked.filter((p) => p !== protein));
  const tickedCount = (homologs ?? []).filter((h) => ticked.includes(h.protein)).length;
  const shown = (homologs ?? []).filter((h) => matchesFilter(h, filter));
  const shownTicked = shown.filter((h) => ticked.includes(h.protein)).length;
  function tickShown(on: boolean) {
    const ids = shown.map((h) => h.protein);
    setTicked(on ? [...new Set([...ticked, ...ids])] : ticked.filter((p) => !ids.includes(p)));
  }

  return (
    <div className="mb-4 rounded-md border border-line bg-surface-2 p-4">
      <h4 className="mb-1 text-sm font-semibold text-ink">Collect homologs across species</h4>
      <p className="mb-3 text-sm text-ink-muted">
        Fetches one coding sequence of the gene per species within a taxon. Align them to find where the gene is conserved.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <SegmentedControl
          size="sm"
          ariaLabel="Homolog source"
          value={source}
          onChange={setSource}
          options={[
            { value: 'eutils', label: 'GenBank proteins', title: 'Proteins annotated with the gene, then where each is coded (E-utilities)' },
            { value: 'datasets', label: 'NCBI Datasets', title: "The gene's ortholog group, or the taxon's reference genomes (prototype)" },
          ]}
        />
        <span className="text-xs text-ink-faint">
          {source === 'eutils'
            ? 'Any GenBank protein named after the gene, one per species.'
            : "Prototype: NCBI's curated orthologs (fast, mostly eukaryotes); when there are none, each species' reference genome is searched for the gene (slow, prokaryotes)."}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field label="Gene symbol" className="w-40">
          <TextInput value={gene} placeholder={defaultGene || 'e.g. nirS'} onChange={(e) => setGene(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Taxon (name or taxonomy ID)" className="w-56">
          <TextInput value={taxon} placeholder={defaultTaxon || 'e.g. Pseudomonas or 286'} onChange={(e) => setTaxon(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Max species" className="w-28">
          <TextInput type="number" min={2} max={60} value={maxSpecies} onChange={(e) => setMaxSpecies(Math.min(60, Math.max(2, parseInt(e.target.value, 10) || 25)))} className="tabular-nums" />
        </Field>
        <Button variant="primary" disabled={running} onClick={() => void collect()}>
          {running ? `Collecting… ${elapsed}s` : 'Collect homologs'}
        </Button>
      </div>
      {running && (
        <p className="mt-2 text-xs text-ink-muted">
          NCBI can take {source === 'datasets' ? 'a few minutes when it has to search reference genomes one by one' : 'a minute or two for this'}, faster with an NCBI API key in Settings.
        </p>
      )}
      {error && <div role="alert" className="mt-3 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{error}</div>}

      {homologs && homologs.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <TextInput
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search species, strain, accession or protein"
              aria-label="Search the found homologs"
              className="max-w-sm"
              spellCheck={false}
            />
            {filter.trim() && (
              <span className="text-xs tabular-nums text-ink-muted">
                {shown.length} of {homologs.length} shown
              </span>
            )}
          </div>
          <div className="max-h-72 overflow-auto rounded-md border border-line bg-surface">
            <table className="w-full text-left text-xs text-ink-muted">
              <thead className="sticky top-0 bg-surface-2 uppercase">
                <tr>
                  <th className="border-b border-line px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={filter.trim() ? 'Tick all shown' : 'Tick all'}
                      className="h-4 w-4 cursor-pointer accent-accent"
                      checked={shown.length > 0 && shownTicked === shown.length}
                      onChange={(e) => tickShown(e.target.checked)}
                    />
                  </th>
                  <th className="border-b border-line px-3 py-2 font-medium">Species</th>
                  <th className="border-b border-line px-3 py-2 font-medium">Strain</th>
                  <th className="border-b border-line px-3 py-2 font-medium">Record</th>
                  <th className="border-b border-line px-3 py-2 font-medium">Length</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-3 text-center text-ink-faint">
                      No homolog matches &ldquo;{filter.trim()}&rdquo;.
                    </td>
                  </tr>
                )}
                {shown.map((h) => (
                  <tr key={h.protein} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-3 py-1.5">
                      <Checkbox label="" aria-label={h.species} checked={ticked.includes(h.protein)} onChange={(e) => toggle(h.protein, e.target.checked)} />
                    </td>
                    <td className="px-3 py-1.5 text-ink">
                      <em>{h.species}</em>
                      {alreadyIn(h) && (
                        <span className="ml-2 whitespace-nowrap rounded bg-surface-2 px-1.5 py-0.5 text-[11px] not-italic text-ink-faint" title="Already in the alignment input">
                          already used
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">{h.strain ?? '-'}</td>
                    <td className="px-3 py-1.5 font-mono">
                      <a href={`https://www.ncbi.nlm.nih.gov/nuccore/${h.accession}?from=${h.start}&to=${h.end}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        {h.accession}:{h.start}-{h.end}
                      </a>
                    </td>
                    <td className="px-3 py-1.5 tabular-nums">{h.sequence.length.toLocaleString('en-US')} bp</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button disabled={tickedCount < 1} onClick={add}>
              Add {tickedCount} to the alignment input
            </Button>
            <span className="text-xs text-ink-muted">
              {homologs.length} species found{via ? ` via NCBI Datasets ${via}` : ''}. The records are appended to the box below; then align them.
            </span>
          </div>
          {added && (
            <p role="status" className={`mt-2 rounded-md border px-3 py-2 text-sm ${added.count === 0 ? 'border-warning/25 bg-warning-subtle text-warning' : 'border-line bg-surface text-ink-muted'}`}>
              {added.count === 0
                ? `Already used: ${added.already.length === 1 ? `${added.already[0]} is` : `all ${added.already.length} ticked are`} already in the alignment input. Nothing added.`
                : `Added ${added.count} to the alignment input.`}
              {added.count > 0 && added.already.length > 0 && ` Skipped ${added.already.length} already used: ${added.already.join(', ')}.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
