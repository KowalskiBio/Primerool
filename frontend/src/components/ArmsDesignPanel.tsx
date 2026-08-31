import { useState } from 'react';
import type { SequenceData } from '../api/sequence';
import { searchVariants, type VariantHit } from '../api/variants';
import { designArms, type ArmsAllelePrimerResult, type ArmsCommonCandidateResult, type DesignArmsResponse } from '../api/design';
import { ApiError } from '../api/client';
import type { Selection, Selections } from '../utils/regionMapping';
import { normalizedTupleToInterval } from '../utils/coords';
import ResultsTable from './ResultsTable';
import { fmt, yesNo } from '../utils/format';

interface Props {
  data: SequenceData;
  species: string;
  onSelect: (key: keyof Selections, value: Selection) => void;
}

interface SelectedVariant {
  pos: number;
  refAllele: string;
  altAllele: string;
}

export default function ArmsDesignPanel({ data, species, onSelect }: Props) {
  const [regionStart, setRegionStart] = useState(0);
  const [regionEnd, setRegionEnd] = useState(Math.min(500, data.gene_len));
  const [hits, setHits] = useState<VariantHit[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expandedHitId, setExpandedHitId] = useState<string | null>(null);
  const [hitRefAllele, setHitRefAllele] = useState<Record<string, string>>({});
  const [hitAltAllele, setHitAltAllele] = useState<Record<string, string>>({});

  const [manualPos, setManualPos] = useState(0);
  const [manualRef, setManualRef] = useState('');
  const [manualAlt, setManualAlt] = useState('');

  const [selectedVariant, setSelectedVariant] = useState<SelectedVariant | null>(null);

  const [mismatchEnabled, setMismatchEnabled] = useState(true);
  const [mismatchOffset, setMismatchOffset] = useState(3);

  const [designLoading, setDesignLoading] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [result, setResult] = useState<DesignArmsResponse | null>(null);

  const canUseVariantSearch = data.include_introns;

  async function runSearch() {
    setSearchError(null);
    if (!canUseVariantSearch) {
      setSearchError("Enable 'Include introns' in step 2 to use variant search (genomic coordinates only map onto the intron-inclusive gene sequence).");
      return;
    }
    if (regionEnd <= regionStart) {
      setSearchError('Region end must be after region start.');
      return;
    }
    setSearchLoading(true);
    setHits(null);
    try {
      const res = await searchVariants({
        chrom: data.chrom,
        species,
        start: data.gene_start_genomic + regionStart,
        end: data.gene_start_genomic + regionEnd,
      });
      setHits(res.variants);
      if (!res.variants.length) setSearchError('No known variants found in this region.');
    } catch (e) {
      setSearchError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setHits(null);
    } finally {
      setSearchLoading(false);
    }
  }

  function localPosForHit(hit: VariantHit): number | null {
    if (!canUseVariantSearch) return null;
    const local = data.strand === '-' ? data.gene_end_genomic - hit.end : hit.start - data.gene_start_genomic;
    if (local < 0 || local >= data.gene_seq.length) return null;
    return local;
  }

  function confirmHitSelection(hit: VariantHit) {
    const local = localPosForHit(hit);
    if (local === null) {
      setSearchError('This variant maps outside the loaded gene sequence.');
      return;
    }
    const ref = hitRefAllele[hit.id] ?? hit.alleles[0] ?? '';
    const alt = hitAltAllele[hit.id] ?? hit.alleles[1] ?? '';
    if (!ref || !alt || ref === alt) {
      setSearchError('Pick two distinct alleles (ref and alt) before using this variant.');
      return;
    }
    setResult(null);
    setDesignError(null);
    setSelectedVariant({ pos: local, refAllele: ref, altAllele: alt });
  }

  function useManualVariant() {
    setDesignError(null);
    if (!manualRef.trim() || !manualAlt.trim()) {
      setDesignError('Enter both a ref and an alt allele.');
      return;
    }
    if (manualRef.trim().toUpperCase() === manualAlt.trim().toUpperCase()) {
      setDesignError('Ref and alt alleles must differ.');
      return;
    }
    setResult(null);
    setSelectedVariant({ pos: manualPos, refAllele: manualRef.trim().toUpperCase(), altAllele: manualAlt.trim().toUpperCase() });
  }

  function selectAllele(which: 'ref' | 'alt', p: ArmsAllelePrimerResult) {
    const [start, end] = normalizedTupleToInterval(p.position);
    onSelect(which === 'ref' ? 'armsRefPrimer' : 'armsAltPrimer', {
      region: 'gene',
      start,
      end,
      primerSeq: p.sequence,
      bindingSeq: (data.gene_seq || '').substring(start, end),
      source: 'recommended',
    });
  }

  function selectCommon(c: ArmsCommonCandidateResult) {
    const [start, end] = normalizedTupleToInterval(c.position);
    onSelect('armsCommon', {
      region: 'gene',
      start,
      end,
      primerSeq: c.sequence,
      bindingSeq: (data.gene_seq || '').substring(start, end),
      source: 'recommended',
    });
  }

  async function runDesign() {
    setDesignError(null);
    if (!selectedVariant) {
      setDesignError('Select a variant first (via search or manual entry).');
      return;
    }
    setDesignLoading(true);
    setResult(null);
    try {
      const res = await designArms({
        sequence: data.gene_seq,
        variant_pos: selectedVariant.pos,
        ref_allele: selectedVariant.refAllele,
        alt_allele: selectedVariant.altAllele,
        mismatch_enabled: mismatchEnabled,
        mismatch_offset: mismatchOffset,
      });
      setResult(res);
      selectAllele('ref', res.ref_primer);
      selectAllele('alt', res.alt_primer);
      if (res.common_candidates[0]) selectCommon(res.common_candidates[0]);
    } catch (e) {
      setDesignError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setDesignLoading(false);
    }
  }

  return (
    <div>
      <div className="bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-700 mb-6">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Search known variants (Ensembl)</h3>
        {!canUseVariantSearch && (
          <div className="text-sm text-amber-800 dark:text-amber-300 mb-3 bg-amber-50 dark:bg-amber-950/40 p-2 rounded border border-amber-100 dark:border-amber-900">
            Enable &ldquo;Include introns&rdquo; in step 2 to search for known variants (genomic coordinates only map exactly onto the intron-inclusive gene sequence). You can still enter a variant manually below.
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Region start (bp, 0-based into gene sequence):</label>
            <input type="number" min={0} value={regionStart} onChange={(e) => setRegionStart(parseInt(e.target.value, 10) || 0)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Region end (bp, exclusive):</label>
            <input type="number" min={0} value={regionEnd} onChange={(e) => setRegionEnd(parseInt(e.target.value, 10) || 0)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
          </div>
          <div className="flex items-end">
            <button disabled={searchLoading} onClick={() => void runSearch()} className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm w-full">
              {searchLoading ? 'Searching…' : 'Search Variants'}
            </button>
          </div>
        </div>

        {searchError && <div className="p-3 mb-3 text-sm text-red-800 dark:text-red-300 rounded-lg bg-red-50 dark:bg-red-950/40">{searchError}</div>}

        {hits && hits.length > 0 && (
          <ResultsTable
            rows={hits}
            keyOf={(h) => h.id}
            columns={[
              { header: 'ID', render: (h) => h.id, className: 'font-mono' },
              { header: 'Position', render: (h) => (h.start === h.end ? h.start : `${h.start}-${h.end}`) },
              { header: 'Alleles', render: (h) => h.alleles.join('/'), className: 'font-mono' },
              { header: 'Consequence', render: (h) => h.consequence_type || '—' },
              { header: 'Clinical significance', render: (h) => (h.clinical_significance.length ? h.clinical_significance.join(', ') : '—') },
              {
                header: 'Select',
                render: (h) => (
                  <div>
                    {expandedHitId !== h.id ? (
                      <button
                        className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition disabled:opacity-50"
                        disabled={localPosForHit(h) === null}
                        title={localPosForHit(h) === null ? 'This variant maps outside the loaded gene sequence.' : undefined}
                        onClick={() => setExpandedHitId(h.id)}
                      >
                        Select
                      </button>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1">
                          <span className="text-xs">Ref:</span>
                          <select className="text-xs rounded border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700" value={hitRefAllele[h.id] ?? h.alleles[0] ?? ''} onChange={(e) => setHitRefAllele((prev) => ({ ...prev, [h.id]: e.target.value }))}>
                            {h.alleles.map((a) => (
                              <option key={a} value={a}>
                                {a}
                              </option>
                            ))}
                          </select>
                          <span className="text-xs">Alt:</span>
                          <select className="text-xs rounded border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700" value={hitAltAllele[h.id] ?? h.alleles[1] ?? ''} onChange={(e) => setHitAltAllele((prev) => ({ ...prev, [h.id]: e.target.value }))}>
                            {h.alleles.map((a) => (
                              <option key={a} value={a}>
                                {a}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => confirmHitSelection(h)}>
                          Use this variant
                        </button>
                      </div>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </div>

      <div className="bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-700 mb-6">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Or enter a variant manually</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Position (bp, 0-based into gene sequence):</label>
            <input type="number" min={0} value={manualPos} onChange={(e) => setManualPos(parseInt(e.target.value, 10) || 0)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Ref allele:</label>
            <input type="text" value={manualRef} onChange={(e) => setManualRef(e.target.value)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border font-mono" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Alt allele:</label>
            <input type="text" value={manualAlt} onChange={(e) => setManualAlt(e.target.value)} className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border font-mono" />
          </div>
        </div>
        <button onClick={useManualVariant} className="mt-3 px-4 py-2 text-sm font-medium bg-green-600 border border-green-600 rounded hover:bg-green-700 text-white transition-colors shadow-sm">
          Use this variant
        </button>
      </div>

      {selectedVariant && (
        <div className="text-sm text-slate-700 dark:text-slate-300 mb-4 bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-700">
          Selected variant: position <strong>{selectedVariant.pos}</strong>, ref <strong className="font-mono">{selectedVariant.refAllele}</strong> / alt <strong className="font-mono">{selectedVariant.altAllele}</strong>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4 mb-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={mismatchEnabled} onChange={(e) => setMismatchEnabled(e.target.checked)} className="accent-green-600 w-4 h-4" />
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">Add destabilizing mismatch</span>
        </label>
        {mismatchEnabled && (
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Mismatch offset (bases from 3' end):</label>
            <input type="number" min={1} value={mismatchOffset} onChange={(e) => setMismatchOffset(parseInt(e.target.value, 10) || 1)} className="w-32 rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-3 py-2 border" />
          </div>
        )}
        <button disabled={designLoading || !selectedVariant} onClick={() => void runDesign()} className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm">
          {designLoading ? 'Designing…' : 'Design ARMS Primers'}
        </button>
      </div>

      {designError && <div className="p-4 mb-4 text-sm text-red-800 dark:text-red-300 rounded-lg bg-red-50 dark:bg-red-950/40">{designError}</div>}

      {result && (
        <div className="mt-2 space-y-4">
          <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mb-2">Allele-Specific Primers</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { label: 'Ref', p: result.ref_primer, which: 'ref' as const },
              { label: 'Alt', p: result.alt_primer, which: 'alt' as const },
            ].map(({ label, p, which }) => (
              <div key={which} className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                    {label} allele ({which === 'ref' ? selectedVariant?.refAllele : selectedVariant?.altAllele})
                  </span>
                  <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => selectAllele(which, p)}>
                    Highlight
                  </button>
                </div>
                <p className="font-mono text-sm text-slate-800 dark:text-slate-200 break-all">{p.sequence}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Len {p.length} | Tm {fmt(p.tm)} | GC% {fmt(p.gc_percent)} | Hairpin {yesNo(p.hairpin.structure_found)} | Homodimer {yesNo(p.homodimer.structure_found)}
                  {p.mismatch_position !== null && <> | Mismatch at position {p.mismatch_position}</>}
                </p>
              </div>
            ))}
          </div>

          <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mb-2 mt-4">Common Primer Candidates</h3>
          <div className="text-sm text-slate-500 dark:text-slate-400 mb-4 bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 p-2 rounded border border-slate-100 dark:border-slate-700">
            The common primer is shared by both reactions (ref-specific + common, alt-specific + common) — selecting one row highlights it for both.
          </div>
          <ResultsTable
            rows={result.common_candidates}
            keyOf={(c, i) => `c-${i}-${c.sequence}`}
            columns={[
              { header: '#', render: (_c, i) => i + 1 },
              { header: "Sequence (5'→3')", render: (c) => c.sequence, className: 'font-mono text-slate-800 dark:text-slate-200' },
              { header: 'Tm', render: (c) => fmt(c.tm) },
              { header: 'GC%', render: (c) => fmt(c.gc_percent) },
              { header: 'Product (ref)', render: (c) => c.product_size_ref },
              { header: 'Product (alt)', render: (c) => c.product_size_alt },
              { header: 'Hairpin', render: (c) => yesNo(c.hairpin.structure_found) },
              { header: 'Homodimer', render: (c) => yesNo(c.homodimer.structure_found) },
              {
                header: 'Action',
                render: (c) => (
                  <button className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition" onClick={() => selectCommon(c)}>
                    Use
                  </button>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
