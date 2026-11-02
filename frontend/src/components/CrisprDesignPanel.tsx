import { useState } from 'react';
import { useSessionState } from '../session/sessionContext';
import type { SequenceData } from '../api/sequence';
import { designCrispr, type CloningVectorName, type GuideResult } from '../api/crispr';
import { ApiError } from '../api/client';
import type { Selection, Selections } from '../utils/regionMapping';
import ResultsTable from './ResultsTable';
import PrimerSequence from './PrimerSequence';
import Badge from './ui/Badge';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
import Field from './ui/Field';
import TextInput from './ui/TextInput';
import Select from './ui/Select';
import { fmt } from '../utils/format';

const VECTORS: CloningVectorName[] = ['pX330', 'lentiCRISPRv2'];

interface Props {
  data: SequenceData;
  species: string;
  onSelect: (key: keyof Selections, value: Selection) => void;
}

/** A guide's `[start, end)` and strand as a map selection. The spacer is
 * already on its own strand, and the template at `interval` is the plus
 * strand, so a minus guide's `primerSeq` differs from its `bindingSeq` —
 * which is exactly the convention `selectionStrand` infers from. */
function guideSelection(data: SequenceData, g: GuideResult): Selection {
  const [start, end] = g.interval;
  return {
    region: 'gene',
    start,
    end,
    primerSeq: g.sequence,
    bindingSeq: (data.gene_seq || '').substring(start, end),
    source: 'recommended',
    strand: g.strand === '+' ? 'F' : 'R',
  };
}

/** The 1-based, inclusive window a user typed, as 0-based `[start, end)`
 * into `gene_seq` — or the whole gene when both boxes are blank. Returns
 * `null` when what they typed cannot be used. */
function parseWindow(fromText: string, toText: string, geneLen: number): { start: number; end: number } | null {
  const from = fromText.trim();
  const to = toText.trim();
  if (!from && !to) return { start: 0, end: geneLen };
  const start = from ? parseInt(from, 10) - 1 : 0;
  const end = to ? parseInt(to, 10) : geneLen;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end > geneLen || end - start < 23) return null;
  return { start, end };
}

export default function CrisprDesignPanel({ data, species, onSelect }: Props) {
  const [windowFrom, setWindowFrom] = useSessionState('crispr.windowFrom', '');
  const [windowTo, setWindowTo] = useSessionState('crispr.windowTo', '');
  const [vector, setVector] = useSessionState<CloningVectorName>('crispr.vector', 'pX330');
  const [allowPolyT, setAllowPolyT] = useSessionState('crispr.allowPolyT', false);
  const [numReturn, setNumReturn] = useSessionState('crispr.numReturn', 10);
  const [guides, setGuides] = useSessionState<GuideResult[] | null>('crispr.guides', null);
  const [explain, setExplain] = useSessionState<string | null>('crispr.explain', null);
  const [chosen, setChosen] = useSessionState<string | null>('crispr.chosen', null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const geneSeq = data.gene_seq || '';
  const win = parseWindow(windowFrom, windowTo, geneSeq.length);

  async function run() {
    setError(null);
    if (!win) {
      setError(`Enter a window inside 1–${geneSeq.length} that is at least 23 bp long, or leave both boxes blank for the whole gene.`);
      return;
    }
    setLoading(true);
    try {
      const res = await designCrispr(geneSeq.substring(win.start, win.end), win.start, { num_return: numReturn, allow_poly_t: allowPolyT, vector });
      setGuides(res.guides);
      setExplain(res.explain);
      const first = res.guides[0];
      if (first) {
        setChosen(first.sequence);
        onSelect('crisprGuide', guideSelection(data, first));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setGuides(null);
      setExplain(null);
    } finally {
      setLoading(false);
    }
  }

  function use(g: GuideResult) {
    setChosen(g.sequence);
    onSelect('crisprGuide', guideSelection(data, g));
  }

  const picked = guides?.find((g) => g.sequence === chosen) ?? null;

  return (
    <div>
      <div className="mb-6 rounded-md border border-line bg-surface-2 p-4">
        <p className="mb-4 text-sm text-ink-muted">
          Finds SpCas9 guides (20 nt spacer, <span className="font-mono">NGG</span> PAM) on both strands of the gene, ranked by GC%, homopolymer runs, self-structure and the PAM-proximal base. Guides with a{' '}
          <span className="font-mono">TTTT</span> run are dropped: it terminates U6 transcription.
        </p>
        <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label="Window from (bp)" hint="1-based, inclusive. Blank = whole gene.">
            <TextInput type="number" min={1} placeholder="1" value={windowFrom} onChange={(e) => setWindowFrom(e.target.value)} className="tabular-nums" />
          </Field>
          <Field label="Window to (bp)">
            <TextInput type="number" min={1} placeholder={String(geneSeq.length)} value={windowTo} onChange={(e) => setWindowTo(e.target.value)} className="tabular-nums" />
          </Field>
          <Field label="Guides to return">
            <TextInput type="number" min={1} value={numReturn} onChange={(e) => setNumReturn(parseInt(e.target.value, 10) || 1)} className="tabular-nums" />
          </Field>
          <Field label="Cloning vector" hint="Sets the enzyme named beside the oligos.">
            <Select value={vector} onChange={(e) => setVector(e.target.value as CloningVectorName)}>
              {VECTORS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Checkbox checked={allowPolyT} onChange={(e) => setAllowPolyT(e.target.checked)} label="Keep guides with a TTTT run (only if a non-U6 promoter or synthetic RNA is used)" />
      </div>

      <Button variant="primary" className="mb-4" disabled={loading} onClick={() => void run()}>
        {loading ? 'Scanning…' : 'Find Guides'}
      </Button>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">
          {error}
        </div>
      )}

      {guides && explain && <p className="mb-3 text-xs text-ink-muted">{explain}</p>}

      {guides && guides.length > 0 && (
        <>
          <ResultsTable
            rows={guides}
            keyOf={(g) => g.sequence}
            selectedKey={chosen}
            columns={[
              { header: '#', render: (_g, i) => i + 1, width: '2.5rem' },
              {
                header: "Spacer (5'→3')",
                render: (g) => <PrimerSequence sequence={g.sequence} label="sgRNA spacer" organism={species} className="font-mono text-ink" />,
                width: '16rem',
              },
              { header: 'PAM', render: (g) => <span className="font-mono">{g.pam}</span>, width: '4rem' },
              { header: 'Strand', render: (g) => g.strand, width: '4rem' },
              { header: 'Position', render: (g) => `${g.interval[0] + 1}–${g.interval[1]}`, width: '7.5rem', className: 'whitespace-nowrap tabular-nums' },
              { header: 'Cut at', render: (g) => g.cut_site + 1, width: '5rem', className: 'tabular-nums' },
              { header: 'GC%', render: (g) => fmt(g.gc_percent), width: '4.5rem' },
              { header: 'Score', render: (g) => g.score.toFixed(0), width: '4.5rem', className: 'tabular-nums' },
              {
                header: 'Notes',
                render: (g) =>
                  g.warnings.length === 0 ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {g.warnings.map((w) => (
                        <Badge key={w.code} title={w.message}>
                          {w.code.replace(/_/g, ' ')}
                        </Badge>
                      ))}
                    </div>
                  ),
              },
              {
                header: 'Highlight',
                width: '5rem',
                render: (g) => (
                  <Button size="sm" onClick={() => use(g)}>
                    Use
                  </Button>
                ),
              },
            ]}
          />

          {picked && (
            <div className="mt-6 rounded-md border border-line bg-surface-2 p-4">
              <h4 className="mb-1 text-sm font-semibold text-ink">
                Cloning oligos · {picked.cloning.vector} ({picked.cloning.enzyme})
              </h4>
              <p className="mb-3 text-xs text-ink-muted">
                Anneal the two oligos and ligate into the {picked.cloning.enzyme}-cut backbone.{' '}
                {picked.cloning.added_5prime_g
                  ? 'A 5′ G was added for the U6 promoter, so the cloned spacer is 21 nt.'
                  : 'The spacer already starts with G, so nothing was added.'}{' '}
                Check the overhangs against your own backbone's protocol before ordering — they must match it exactly.
              </p>
              <dl className="grid grid-cols-1 gap-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <dt className="w-20 shrink-0 text-ink-muted">Top</dt>
                  <dd>
                    <PrimerSequence sequence={picked.cloning.top} label="Guide cloning oligo (top)" organism={species} className="font-mono text-ink" />
                  </dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-2">
                  <dt className="w-20 shrink-0 text-ink-muted">Bottom</dt>
                  <dd>
                    <PrimerSequence sequence={picked.cloning.bottom} label="Guide cloning oligo (bottom)" organism={species} className="font-mono text-ink" />
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-ink-muted">
                No off-target search has been run. Right-click the spacer to BLAST it — but note BLAST misses close-but-mismatched sites, which are the ones that matter most for a guide, so treat it as a sanity check rather
                than a specificity guarantee.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
