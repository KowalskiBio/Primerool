import { useState } from 'react';
import { importSnpDocx, importSnpText, type SnpBlock } from '../api/snpImport';
import { designFlanking, type DesignEngine, type FlankingOligoResult } from '../api/design';
import { ApiError } from '../api/client';
import EngineSelect from './EngineSelect';
import SnpAmpliconMap, { type PlacedAmplicon } from './SnpAmpliconMap';
import Card from './Card';
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
 * intersect — the actual PCR products, not the raw 200bp report windows
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
    .map(({ b, r }) => ({ rsid: b.rsid, gene: b.gene, chrom: b.chrom, position: b.position, ampStart: r.ampStart, ampEnd: r.ampEnd, productSize: r.productSize }));

  return (
    <>
      <div className="bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-700 mb-6">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Import SNP flanking blocks &amp; design flanking primers</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Upload a per-SNP flanking-sequence report (.docx — one 401 bp block per variant, target marked as <code>[REF/ALT]</code>), or paste its plain text. Each block is split into upstream/downstream flanks at the marker and run
          through WGA/flanking primer design in one batch.
        </p>

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <label className="inline-flex items-center gap-2 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-green-50 dark:hover:bg-slate-600 font-medium rounded-lg px-4 py-2 text-sm cursor-pointer transition-colors">
            {importing ? 'Importing…' : 'Upload .docx'}
            <input type="file" accept=".docx" className="hidden" onChange={(e) => void handleFile(e)} disabled={importing} />
          </label>
          {blocks && <span className="text-sm text-slate-600 dark:text-slate-300">{blocks.length} SNP block(s) parsed.</span>}
        </div>

        <details className="mb-3">
          <summary className="text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none">Or paste the report's plain text instead</summary>
          <div className="mt-2">
            <textarea
              rows={5}
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder={'rs2333526   chr4:176782151\nAlely T/A/C   |   RefSeq NC_000004.12   |   interval 176781951–176782351\n5′→3′ plus vlákno\n   176781951  CAGAGTGGCA ...'}
              className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm focus:border-green-500 focus:ring-green-500 font-mono text-xs p-3 border resize-y mb-2"
            />
            <button
              disabled={importing || !pastedText.trim()}
              onClick={() => void handleParseText()}
              className="bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-green-50 dark:hover:bg-slate-600 disabled:opacity-50 font-medium rounded-lg px-4 py-1.5 text-sm transition-colors"
            >
              Parse pasted text
            </button>
            <p className="text-xs text-slate-400 mt-1">No summary table in a paste, so "other target in region" flags won't be available on this path — upload the .docx for those.</p>
          </div>
        </details>

        {importError && <div className="p-3 mb-3 text-sm text-red-800 dark:text-red-300 rounded-lg bg-red-50 dark:bg-red-950/40">{importError}</div>}

        {blocks && blocks.length > 0 && (
          <>
            <div className="flex flex-wrap items-end gap-4 mb-3 pt-3 border-t border-slate-200 dark:border-slate-700">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">Primer search window (bp from target; blank = full 200bp flank):</label>
                <input
                  type="number"
                  min={1}
                  placeholder="e.g. 130 for 2×150bp sequencing"
                  value={flankWindow}
                  onChange={(e) => setFlankWindow(e.target.value)}
                  className="w-56 rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border"
                />
              </div>
              <EngineSelect value={engine} onChange={setEngine} />
              <button
                disabled={running}
                onClick={() => void runBatch()}
                className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 text-sm transition-colors shadow-sm"
              >
                {running ? `Designing… (${doneCount + errorCount}/${blocks.length})` : `Design flanking primers for all ${blocks.length} SNPs`}
              </button>
              {Object.keys(results).length > 0 && !running && (
                <button onClick={exportCsv} className="bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-green-50 dark:hover:bg-slate-600 font-medium rounded-lg px-4 py-2 text-sm transition-colors">
                  Export CSV
                </button>
              )}
            </div>

            <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-x-auto">
              <table className="w-full text-xs text-left text-slate-600 dark:text-slate-300">
                <thead className="uppercase bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 text-slate-700 dark:text-slate-300">
                  <tr>
                    <th className="px-2 py-2 border-b border-slate-200 dark:border-slate-700">Gene</th>
                    <th className="px-2 py-2 border-b border-slate-200 dark:border-slate-700">rsID</th>
                    <th className="px-2 py-2 border-b border-slate-200 dark:border-slate-700">Position</th>
                    <th className="px-2 py-2 border-b border-slate-200 dark:border-slate-700">Forward (5'→3')</th>
                    <th className="px-2 py-2 border-b border-slate-200 dark:border-slate-700">Reverse (5'→3')</th>
                    <th className="px-2 py-2 border-b border-slate-200 dark:border-slate-700">Product</th>
                    <th className="px-2 py-2 border-b border-slate-200 dark:border-slate-700">Amplicons overlap?</th>
                    <th className="px-2 py-2 border-b border-slate-200 dark:border-slate-700">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {blocks.map((b) => {
                    const r = results[b.rsid];
                    return (
                      <tr key={b.rsid} className="bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 last:border-0 hover:bg-green-50/50 dark:hover:bg-slate-700/40">
                        <td className="px-2 py-2">{b.gene}</td>
                        <td className="px-2 py-2">
                          {b.rsid}
                          {b.other_targets.length > 0 && (
                            <span title={`Shares this window with: ${b.other_targets.join(', ')} — verify primers don't overlap its position.`} className="ml-1 text-amber-600 dark:text-amber-400">
                              ⚠
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 font-mono">
                          {b.chrom}:{b.position.toLocaleString()}
                        </td>
                        <td className="px-2 py-2 font-mono break-all">{r?.fwd ? `${r.fwd.sequence} (${fmt(r.fwd.tm)}°C)` : '—'}</td>
                        <td className="px-2 py-2 font-mono break-all">{r?.rev ? `${r.rev.sequence} (${fmt(r.rev.tm)}°C)` : '—'}</td>
                        <td className="px-2 py-2">{r?.productSize ?? '—'}</td>
                        <td className="px-2 py-2">
                          {r?.status !== 'done' && '—'}
                          {r?.status === 'done' &&
                            (overlaps[b.rsid]?.length ? (
                              <span className="text-red-600 dark:text-red-400" title={`Amplicon overlaps: ${overlaps[b.rsid].join(', ')}`}>
                                ⚠ overlaps {overlaps[b.rsid].join(', ')}
                              </span>
                            ) : (
                              <span className="text-green-600 dark:text-green-400">✓ no overlap</span>
                            ))}
                        </td>
                        <td className="px-2 py-2">
                          {!r && '—'}
                          {r?.status === 'pending' && <span className="text-slate-400">queued</span>}
                          {r?.status === 'running' && <span className="text-blue-500">designing…</span>}
                          {r?.status === 'done' && <span className="text-green-600 dark:text-green-400">ok</span>}
                          {r?.status === 'error' && <span className="text-red-600 dark:text-red-400">{r.error}</span>}
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
        <Card title="Amplicon map">
          <SnpAmpliconMap amplicons={placedAmplicons} overlaps={overlaps} />
        </Card>
      )}
    </>
  );
}
