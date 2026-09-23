import { useMemo, useState } from 'react';
import { importSnpDocx, importSnpText, type SnpBlock } from '../api/snpImport';
import { designFlanking, type DesignEngine, type FlankingOligoResult } from '../api/design';
import { ApiError } from '../api/client';
import EngineSelect from './EngineSelect';
import SnpAmpliconMap, { type PlacedAmplicon } from './SnpAmpliconMap';
import SnpGeneMapModal from './SnpGeneMapModal';
import Section from './ui/Section';
import Badge from './ui/Badge';
import Button from './ui/Button';
import Field from './ui/Field';
import TextInput, { controlClasses } from './ui/TextInput';
import { fmt } from '../utils/format';

interface BatchResult {
  status: 'pending' | 'running' | 'done' | 'error';
  fwd?: FlankingOligoResult;
  rev?: FlankingOligoResult;
  productSize?: number;
  /** Genomic coordinates of the designed amplicon (1-based, inclusive), only set on success. */
  ampStart?: number;
  ampEnd?: number;
  pairFound?: boolean;
  pairDg?: number | null;
  error?: string;
  /** Notes on avoiding a neighboring listed SNP's exact position when
   * picking among the returned primer candidates (see `pickAvoidingCandidate`). */
  notes?: { tone: 'accent' | 'danger'; text: string }[];
}

/** From the returned candidates for one side (forward/reverse), picks the
 * first whose genomic span clears every position in `avoid` — falling back
 * to the top-ranked candidate (with `unresolved` listing what it still
 * overlaps) if none do. `hits0` is what the top-ranked candidate alone hit,
 * used to explain *why* a switch happened even when it succeeded. */
function pickAvoidingCandidate<T>(candidates: T[], toGenomicSpan: (c: T) => [number, number], avoid: { rsid: string; pos: number }[]): { chosen: T; index: number; hits0: { rsid: string; pos: number }[]; unresolved: { rsid: string; pos: number }[] } | null {
  if (!candidates.length) return null;
  const hitsOf = (c: T) => {
    const [s, e] = toGenomicSpan(c);
    return avoid.filter((a) => a.pos >= s && a.pos <= e);
  };
  const hits0 = hitsOf(candidates[0]);
  if (!hits0.length) return { chosen: candidates[0], index: 0, hits0, unresolved: [] };
  for (let i = 1; i < candidates.length; i++) {
    if (hitsOf(candidates[i]).length === 0) return { chosen: candidates[i], index: i, hits0, unresolved: [] };
  }
  return { chosen: candidates[0], index: 0, hits0, unresolved: hits0 };
}

/** Every pair of same-chromosome amplicons whose [ampStart, ampEnd] spans
 * intersect - the actual PCR products, not the raw 200bp report windows
 * (those already get their own "shares this window with" flag from
 * `other_targets`). */
function findOverlaps(blocks: SnpBlock[], results: Record<string, BatchResult>): Record<string, string[]> {
  const placed = blocks
    .map((b) => ({ rsid: b.rsid, chrom: b.chrom, r: results[b.rsid] }))
    .filter((p): p is { rsid: string; chrom: string; r: BatchResult & { ampStart: number; ampEnd: number } } => p.r?.status === 'done' && p.r.ampStart !== undefined && p.r.ampEnd !== undefined);

  const overlaps: Record<string, string[]> = {};
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (a.chrom !== b.chrom) continue;
      if (a.r.ampStart <= b.r.ampEnd && b.r.ampStart <= a.r.ampEnd) {
        (overlaps[a.rsid] ??= []).push(b.rsid);
        (overlaps[b.rsid] ??= []).push(a.rsid);
      }
    }
  }
  return overlaps;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function toCsvField(v: string | number | boolean): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function SnpBatchPanel() {
  const [blocks, setBlocks] = useState<SnpBlock[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [pastedText, setPastedText] = useState('');

  const [flankWindow, setFlankWindow] = useState('130');
  const [engine, setEngine] = useState<DesignEngine>('strider');
  const [results, setResults] = useState<Record<string, BatchResult>>({});
  const [running, setRunning] = useState(false);
  const [openGene, setOpenGene] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportError(null);
    setImporting(true);
    setResults({});
    try {
      const base64 = await readFileAsBase64(file);
      const res = await importSnpDocx(base64);
      setBlocks(res.blocks);
    } catch (err) {
      setBlocks(null);
      setImportError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleParseText() {
    if (!pastedText.trim()) return;
    setImportError(null);
    setImporting(true);
    setResults({});
    try {
      const res = await importSnpText(pastedText);
      setBlocks(res.blocks);
    } catch (err) {
      setBlocks(null);
      setImportError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function runBatch() {
    if (!blocks || !blocks.length) return;
    setRunning(true);
    const window = flankWindow.trim() ? parseInt(flankWindow, 10) : undefined;
    const next: Record<string, BatchResult> = {};
    for (const b of blocks) next[b.rsid] = { status: 'pending' };
    setResults(next);

    const positionByRsid = new Map(blocks.map((b) => [b.rsid, b.position]));

    for (const b of blocks) {
      setResults((prev) => ({ ...prev, [b.rsid]: { status: 'running' } }));
      try {
        const res = await designFlanking(b.upstream_seq, b.downstream_seq, engine, window);
        const fwdCandidates = res.primers.forward.primers;
        const revCandidates = res.primers.reverse.primers;
        if (!fwdCandidates.length || !revCandidates.length) {
          setResults((prev) => ({ ...prev, [b.rsid]: { status: 'error', error: 'No primers found in window' } }));
          continue;
        }

        // Prefer a candidate whose binding site clears every other listed
        // SNP known to share this block's window — a primer sitting on an
        // unrelated polymorphism can silently fail to anneal on the allele
        // it doesn't match (allele dropout), which matters more than the
        // amplicons merely overlapping.
        const avoid = b.other_targets.map((rsid) => ({ rsid, pos: positionByRsid.get(rsid) })).filter((x): x is { rsid: string; pos: number } => x.pos !== undefined);
        const fwdPick = pickAvoidingCandidate(fwdCandidates, (c) => [b.interval_start + c.interval[0], b.interval_start + c.interval[1] - 1], avoid)!;
        const revPick = pickAvoidingCandidate(revCandidates, (c) => [b.position + 1 + c.interval[0], b.position + c.interval[1]], avoid)!;
        const fwd = fwdPick.chosen;
        const rev = revPick.chosen;

        const notes: BatchResult['notes'] = [];
        if (fwdPick.unresolved.length) {
          notes.push({ tone: 'danger', text: `Forward primer overlaps ${fwdPick.unresolved.map((h) => h.rsid).join(', ')} (all ${fwdCandidates.length} candidates do; review manually)` });
        } else if (fwdPick.hits0.length) {
          notes.push({ tone: 'accent', text: `Forward: used alt candidate #${fwdPick.index + 1} to avoid ${fwdPick.hits0.map((h) => h.rsid).join(', ')}` });
        }
        if (revPick.unresolved.length) {
          notes.push({ tone: 'danger', text: `Reverse primer overlaps ${revPick.unresolved.map((h) => h.rsid).join(', ')} (all ${revCandidates.length} candidates do; review manually)` });
        } else if (revPick.hits0.length) {
          notes.push({ tone: 'accent', text: `Reverse: used alt candidate #${revPick.index + 1} to avoid ${revPick.hits0.map((h) => h.rsid).join(', ')}` });
        }

        const productSize = b.upstream_seq.length - fwd.interval[0] + 1 + rev.interval[1];
        // Genomic coordinates of the amplicon: the forward primer's 5' end
        // sits `upstream_seq.length - fwd.interval[0]` bases before the
        // variant; the reverse primer's 5' end sits `rev.interval[1]`
        // bases after it.
        const ampStart = b.position - (b.upstream_seq.length - fwd.interval[0]);
        const ampEnd = b.position + rev.interval[1];
        // The server's heterodimer check is only ever computed for the
        // top-ranked forward/reverse pair — if either side switched
        // candidates to avoid a neighbor, that check no longer applies to
        // the pair actually used, so don't report it as if it did.
        const usedDefaultPair = fwdPick.index === 0 && revPick.index === 0;
        setResults((prev) => ({
          ...prev,
          [b.rsid]: {
            status: 'done',
            fwd,
            rev,
            productSize,
            ampStart,
            ampEnd,
            pairFound: usedDefaultPair ? (res.primers.pair_metrics?.heterodimer.structure_found ?? false) : undefined,
            pairDg: usedDefaultPair ? (res.primers.pair_metrics?.heterodimer.dg ?? null) : undefined,
            notes,
          },
        }));
      } catch (err) {
        const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
        setResults((prev) => ({ ...prev, [b.rsid]: { status: 'error', error: message } }));
      }
    }
    setRunning(false);
  }

  function exportCsv() {
    if (!blocks) return;
    const header = ['gene', 'rsid', 'chrom', 'position', 'alleles', 'other_targets', 'forward_primer', 'forward_tm', 'reverse_primer', 'reverse_tm', 'product_size', 'amplicon_start', 'amplicon_end', 'amplicon_overlaps', 'primer_notes', 'heterodimer_found', 'heterodimer_dg', 'status'];
    const rows = blocks.map((b) => {
      const r = results[b.rsid];
      return [
        b.gene,
        b.rsid,
        b.chrom,
        b.position,
        b.alleles.join('/'),
        b.other_targets.join(';'),
        r?.fwd?.sequence ?? '',
        r?.fwd?.tm ?? '',
        r?.rev?.sequence ?? '',
        r?.rev?.tm ?? '',
        r?.productSize ?? '',
        r?.ampStart ?? '',
        r?.ampEnd ?? '',
        (overlaps[b.rsid] || []).join(';'),
        (r?.notes || []).map((n) => n.text).join(' | '),
        r?.pairFound ?? '',
        r?.pairDg ?? '',
        r?.status ?? 'not run',
      ]
        .map(toCsvField)
        .join(',');
    });
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'snp_flanking_primers.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const doneCount = Object.values(results).filter((r) => r.status === 'done').length;
  const errorCount = Object.values(results).filter((r) => r.status === 'error').length;

  // Batches top out around a few dozen SNPs, so recomputing these plainly
  // on every render (rather than reaching for useMemo) is cheap enough.
  const overlaps = findOverlaps(blocks || [], results);

  const placedAmplicons: PlacedAmplicon[] = (blocks || [])
    .map((b) => ({ b, r: results[b.rsid] }))
    .filter((x): x is { b: SnpBlock; r: BatchResult & { ampStart: number; ampEnd: number; productSize: number } } => x.r?.status === 'done' && x.r.ampStart !== undefined && x.r.ampEnd !== undefined && x.r.productSize !== undefined)
    .map(({ b, r }) => ({
      rsid: b.rsid,
      gene: b.gene,
      chrom: b.chrom,
      position: b.position,
      ampStart: r.ampStart,
      ampEnd: r.ampEnd,
      productSize: r.productSize,
      alleles: b.alleles,
      intervalStart: b.interval_start,
      refSeq: b.upstream_seq + (b.alleles[0] || 'N') + b.downstream_seq,
    }));

  // Kept referentially stable across re-renders (unlike a plain inline
  // `.filter()` in the JSX below) so `SnpGeneMapModal`'s fetch effect,
  // which depends on this array, doesn't refire on every unrelated
  // re-render this panel gets while a batch is running.
  const openGeneBlocks = useMemo(() => (blocks || []).filter((b) => b.gene === openGene), [blocks, openGene]);

  return (
    <>
      <div className="mb-6 rounded-md border border-line bg-surface-2 p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Import SNP flanking blocks &amp; design flanking primers</h3>
        <p className="mb-3 text-xs text-ink-muted">
          Upload a per-SNP flanking-sequence report (.docx; one 401 bp block per variant, target marked as <code>[REF/ALT]</code>), or paste its plain text. Each block is split into upstream/downstream flanks at the marker and run
          through WGA/flanking primer design in one batch.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
            {importing ? 'Importing…' : 'Upload .docx'}
            <input type="file" accept=".docx" className="hidden" onChange={(e) => void handleFile(e)} disabled={importing} />
          </label>
          {blocks && <span className="text-sm text-ink-muted">{blocks.length} SNP block(s) parsed.</span>}
        </div>

        <details className="mb-3">
          <summary className="cursor-pointer select-none text-xs text-ink-muted">Or paste the report's plain text instead</summary>
          <div className="mt-2">
            <textarea
              rows={5}
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder={'rs2333526   chr4:176782151\nAlely T/A/C   |   RefSeq NC_000004.12   |   interval 176781951-176782351\n5′→3′ plus vlákno\n   176781951  CAGAGTGGCA …'}
              className={`${controlClasses} mb-2 resize-y p-3 font-mono text-xs`}
            />
            <Button size="sm" disabled={importing || !pastedText.trim()} onClick={() => void handleParseText()}>
              Parse pasted text
            </Button>
            <p className="mt-1 text-xs text-ink-faint">No summary table in a paste, so "other target in region" flags won't be available on this path; upload the .docx for those.</p>
          </div>
        </details>

        {importError && <div role="alert" className="mb-3 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{importError}</div>}

        {blocks && blocks.length > 0 && (
          <>
            <div className="mb-3 flex flex-wrap items-end gap-4 border-t border-line pt-3">
              <Field label="Primer search window (bp from target; blank = full 200bp flank)">
                <TextInput
                  type="number"
                  min={1}
                  placeholder="e.g. 130 for 2x150bp sequencing…"
                  value={flankWindow}
                  onChange={(e) => setFlankWindow(e.target.value)}
                  className="w-56 tabular-nums"
                />
              </Field>
              <EngineSelect value={engine} onChange={setEngine} />
              <Button variant="primary" disabled={running} onClick={() => void runBatch()}>
                {running ? `Designing… (${doneCount + errorCount}/${blocks.length})` : `Design flanking primers for all ${blocks.length} SNPs`}
              </Button>
              {Object.keys(results).length > 0 && !running && (
                <Button onClick={exportCsv}>Export CSV</Button>
              )}
            </div>

            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left text-xs text-ink-muted">
                <thead className="uppercase text-ink-muted bg-surface-2">
                  <tr>
                    <th className="border-b border-line px-2 py-2 font-medium">Gene</th>
                    <th className="border-b border-line px-2 py-2 font-medium">rsID</th>
                    <th className="border-b border-line px-2 py-2 font-medium">Position</th>
                    <th className="border-b border-line px-2 py-2 font-medium">Forward (5'→3')</th>
                    <th className="border-b border-line px-2 py-2 font-medium">Reverse (5'→3')</th>
                    <th className="border-b border-line px-2 py-2 font-medium">Product</th>
                    <th className="border-b border-line px-2 py-2 font-medium">Amplicons overlap?</th>
                    <th className="border-b border-line px-2 py-2 font-medium">Primer notes</th>
                    <th className="border-b border-line px-2 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {blocks.map((b) => {
                    const r = results[b.rsid];
                    return (
                      <tr
                        key={b.rsid}
                        onClick={() => setOpenGene(b.gene)}
                        title={`Open ${b.gene}'s sequence map`}
                        className="cursor-pointer border-b border-line bg-surface last:border-0 hover:bg-surface-2"
                      >
                        <td className="px-2 py-2">{b.gene}</td>
                        <td className="px-2 py-2 font-mono">
                          {b.rsid}
                          {b.other_targets.length > 0 && (
                            <span title={`Shares this window with: ${b.other_targets.join(', ')}. Primer design tries to pick a candidate whose binding site clears it (see "Primer notes" once designed).`} className="ml-1 text-warning">
                              *
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 font-mono tabular-nums">
                          {b.chrom}:{b.position.toLocaleString()}
                        </td>
                        <td className="break-all px-2 py-2 font-mono">{r?.fwd ? `${r.fwd.sequence} (${fmt(r.fwd.tm)}°C)` : '-'}</td>
                        <td className="break-all px-2 py-2 font-mono">{r?.rev ? `${r.rev.sequence} (${fmt(r.rev.tm)}°C)` : '-'}</td>
                        <td className="px-2 py-2 tabular-nums">{r?.productSize ?? '-'}</td>
                        <td className="px-2 py-2">
                          {r?.status !== 'done' && '-'}
                          {r?.status === 'done' &&
                            (overlaps[b.rsid]?.length ? (
                              <Badge tone="danger" title={`Amplicon overlaps: ${overlaps[b.rsid].join(', ')}`}>
                                overlaps {overlaps[b.rsid].join(', ')}
                              </Badge>
                            ) : (
                              <Badge tone="success">no overlap</Badge>
                            ))}
                        </td>
                        <td className="px-2 py-2">
                          {r?.status === 'done' && r.notes && r.notes.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              {r.notes.map((n, i) => (
                                <Badge key={i} tone={n.tone} title={n.text} className="w-fit">
                                  {n.text}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            r?.status === 'done' && '-'
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {!r && '-'}
                          {r?.status === 'pending' && <span className="text-ink-faint">queued</span>}
                          {r?.status === 'running' && <span className="text-accent">designing…</span>}
                          {r?.status === 'done' && <Badge tone="success">ok</Badge>}
                          {r?.status === 'error' && <span className="text-danger">{r.error}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {placedAmplicons.length > 0 && (
        <Section title="Amplicon map">
          <SnpAmpliconMap amplicons={placedAmplicons} overlaps={overlaps} />
        </Section>
      )}

      <SnpGeneMapModal gene={openGene} blocks={openGeneBlocks} onClose={() => setOpenGene(null)} />
    </>
  );
}
