import { useState } from 'react';
import { importSnpDocx, importSnpText, type SnpBlock } from '../api/snpImport';
import { designFlanking, type DesignEngine, type FlankingOligoResult } from '../api/design';
import { ApiError } from '../api/client';
import EngineSelect from './EngineSelect';
import SnpAmpliconMap, { type PlacedAmplicon } from './SnpAmpliconMap';
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

    for (const b of blocks) {
      setResults((prev) => ({ ...prev, [b.rsid]: { status: 'running' } }));
      try {
        const res = await designFlanking(b.upstream_seq, b.downstream_seq, engine, window);
        const fwd = res.primers.forward.primers[0];
        const rev = res.primers.reverse.primers[0];
        if (!fwd || !rev) {
          setResults((prev) => ({ ...prev, [b.rsid]: { status: 'error', error: 'No primers found in window' } }));
          continue;
        }
        const productSize = b.upstream_seq.length - fwd.interval[0] + 1 + rev.interval[1];
        // Genomic coordinates of the amplicon: the forward primer's 5' end
        // sits `upstream_seq.length - fwd.interval[0]` bases before the
        // variant; the reverse primer's 5' end sits `rev.interval[1]`
        // bases after it.
        const ampStart = b.position - (b.upstream_seq.length - fwd.interval[0]);
        const ampEnd = b.position + rev.interval[1];
        setResults((prev) => ({
          ...prev,
          [b.rsid]: {
            status: 'done',
            fwd,
            rev,
            productSize,
            ampStart,
            ampEnd,
            pairFound: res.primers.pair_metrics?.heterodimer.structure_found ?? false,
            pairDg: res.primers.pair_metrics?.heterodimer.dg ?? null,
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
    const header = ['gene', 'rsid', 'chrom', 'position', 'alleles', 'other_targets', 'forward_primer', 'forward_tm', 'reverse_primer', 'reverse_tm', 'product_size', 'amplicon_start', 'amplicon_end', 'amplicon_overlaps', 'heterodimer_found', 'heterodimer_dg', 'status'];
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
                    <th className="border-b border-line px-2 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {blocks.map((b) => {
                    const r = results[b.rsid];
                    return (
                      <tr key={b.rsid} className="border-b border-line bg-surface last:border-0 hover:bg-surface-2">
                        <td className="px-2 py-2">{b.gene}</td>
                        <td className="px-2 py-2 font-mono">
                          {b.rsid}
                          {b.other_targets.length > 0 && (
                            <span title={`Shares this window with: ${b.other_targets.join(', ')}; verify primers don't overlap its position.`} className="ml-1 text-warning">
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
    </>
  );
}
