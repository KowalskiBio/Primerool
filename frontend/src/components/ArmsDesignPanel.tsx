import { useState } from 'react';
import type { SequenceData } from '../api/sequence';
import { lookupVariant, searchVariants, type VariantHit } from '../api/variants';
import { designArms, type ArmsAllelePrimerResult, type ArmsCommonCandidateResult, type DesignArmsResponse, type DesignEngine } from '../api/design';
import EngineSelect from './EngineSelect';
import { ApiError } from '../api/client';
import type { Selection, Selections } from '../utils/regionMapping';
import { normalizedTupleToInterval } from '../utils/coords';
import { reverseComplement } from '../utils/dna';
import ResultsTable, { type Column } from './ResultsTable';
import PrimerCard from './PrimerCard';
import Badge from './ui/Badge';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
import Field from './ui/Field';
import TextInput from './ui/TextInput';
import type { IdtCredentials } from './IdtSettingsPanel';
import { fmt, yesNo } from '../utils/format';

const PAGE_SIZES = [10, 50, 100] as const;

const HIDDEN_COLUMNS_STORAGE_KEY = 'arms_hidden_variant_columns';

/** Sorts by a column's `sortValue`: numbers compare numerically, everything
 * else as text. `null` (meaning "no value for this row", e.g. an unfetched
 * frequency) always sorts last regardless of direction - the direction only
 * flips the order of rows that actually have a value. */
function sortByColumn<T>(rows: T[], sortValue: (row: T) => string | number | null, direction: 'asc' | 'desc'): T[] {
  const dir = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a);
    const vb = sortValue(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return typeof va === 'number' && typeof vb === 'number' ? dir * (va - vb) : dir * String(va).localeCompare(String(vb));
  });
}

/** A single real nucleotide character - deliberately excludes Ensembl's `-`
 * placeholder for "no base here" (its convention for the deleted/inserted
 * side of an indel), which has `length === 1` but isn't a base. */
function isSingleBase(a: string): boolean {
  return /^[ACGT]$/i.test(a);
}

/** Classic single-letter-position-letter mutation notation (e.g. `C6574T`)
 * - only meaningful for a true single-base substitution; indels have no
 * clean equivalent in this shorthand, so callers get `null` for those.
 * `pos` is 0-based (as used everywhere else in this component/the design
 * API) and is rendered 1-based here, matching this notation's own
 * convention. */
function snpNotation(pos: number, ref: string, alt: string): string | null {
  if (!isSingleBase(ref) || !isSingleBase(alt)) return null;
  return `${ref.toUpperCase()}${pos + 1}${alt.toUpperCase()}`;
}

/** Coarse severity ranking used only to sort/triage the results list, not
 * to make any design decision - lower rank = shown first ("more dangerous
 * / more likely to matter"). Not the full SO consequence-type ontology or
 * ClinVar's own significance model, just enough of a hierarchy to surface
 * pathogenic/high-impact variants above intronic/synonymous ones. */
const CLINICAL_SIGNIFICANCE_ORDER = [
  'pathogenic',
  'likely pathogenic',
  'risk factor',
  'drug response',
  'association',
  'protective',
  'uncertain significance',
  'conflicting interpretations of pathogenicity',
  'not provided',
  'likely benign',
  'benign',
  'other',
];

const CONSEQUENCE_ORDER = [
  'stop_gained',
  'stop_lost',
  'start_lost',
  'frameshift_variant',
  'splice_donor_variant',
  'splice_acceptor_variant',
  'splice_region_variant',
  'transcript_ablation',
  'missense_variant',
  'inframe_insertion',
  'inframe_deletion',
  'protein_altering_variant',
  'incomplete_terminal_codon_variant',
  'coding_sequence_variant',
  'synonymous_variant',
  'stop_retained_variant',
  '5_prime_utr_variant',
  '3_prime_utr_variant',
  'mature_mirna_variant',
  'non_coding_transcript_exon_variant',
  'intron_variant',
  'nmd_transcript_variant',
  'non_coding_transcript_variant',
  'upstream_gene_variant',
  'downstream_gene_variant',
  'regulatory_region_variant',
  'intergenic_variant',
];

function rankIn(order: string[], value: string | null | undefined): number {
  if (!value) return order.length;
  const i = order.indexOf(value.toLowerCase());
  return i === -1 ? order.length - 1 : i;
}

/** Lower = more clinically significant / more likely to matter for ARMS
 * design; used purely to sort the results table, never to filter it - a
 * variant with unrecognized/empty metadata still shows up, just last. */
function dangerScore(h: VariantHit): number {
  const clinical = h.clinical_significance.length ? Math.min(...h.clinical_significance.map((s) => rankIn(CLINICAL_SIGNIFICANCE_ORDER, s))) : CLINICAL_SIGNIFICANCE_ORDER.length;
  return clinical * 100 + rankIn(CONSEQUENCE_ORDER, h.consequence_type);
}

interface Props {
  data: SequenceData;
  species: string;
  apiSource: 'ensembl' | 'ncbi';
  onSelect: (key: keyof Selections, value: Selection) => void;
  idtCredentials?: IdtCredentials;
}

interface SelectedVariant {
  /** Unique within the selection list - a hit's own id for search/lookup
   * picks, or a derived key for manual entries - used for React keys, the
   * "Remove" action, and de-duplication (selecting the same hit twice is a
   * no-op rather than a second entry). */
  key: string;
  label: string;
  pos: number;
  refAllele: string;
  altAllele: string;
}

interface DesignOutcome {
  variant: SelectedVariant;
  response?: DesignArmsResponse;
  error?: string;
}

export default function ArmsDesignPanel({ data, species, apiSource, onSelect, idtCredentials }: Props) {
  const [regionStart, setRegionStart] = useState(0);
  const [regionEnd, setRegionEnd] = useState(Math.min(500, data.gene_len));
  const [lookupId, setLookupId] = useState('');
  const [hits, setHits] = useState<VariantHit[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expandedHitId, setExpandedHitId] = useState<string | null>(null);
  const [hitRefAllele, setHitRefAllele] = useState<Record<string, string>>({});
  const [hitAltAllele, setHitAltAllele] = useState<Record<string, string>>({});
  const [pageSize, setPageSize] = useState<number>(10);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ columnIndex: number; direction: 'asc' | 'desc' } | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_COLUMNS_STORAGE_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  /** Frequency lookups a user has explicitly triggered (per-row "Fetch" or
   * the bulk "Show frequency" button) for hits that didn't already carry
   * `minor_allele_freq` from the search response itself (i.e. position/
   * region search results - see `VariantHit.minor_allele_freq`'s doc).
   * Keyed by variant id; absent = not yet requested. */
  const [frequencies, setFrequencies] = useState<Record<string, { loading: boolean; value: number | null; minorAllele: string | null }>>({});
  const [bulkFreqLoading, setBulkFreqLoading] = useState(false);

  const [manualPos, setManualPos] = useState(0);
  const [manualRef, setManualRef] = useState('');
  const [manualAlt, setManualAlt] = useState('');

  const [selectedVariants, setSelectedVariants] = useState<SelectedVariant[]>([]);

  const [mismatchEnabled, setMismatchEnabled] = useState(true);
  const [mismatchOffset, setMismatchOffset] = useState(3);
  const [engine, setEngine] = useState<DesignEngine>('strider');

  const [designLoading, setDesignLoading] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [results, setResults] = useState<DesignOutcome[]>([]);
  /** `${variant.key}:${sequence}` of the common candidate last picked for
   * that variant, so the matching PrimerCard shows "Used". */
  const [usedCommonKey, setUsedCommonKey] = useState<string | null>(null);

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
    setPage(0);
    try {
      const res = await searchVariants({
        chrom: data.chrom,
        species,
        api_source: apiSource,
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

  async function runLookupById() {
    setSearchError(null);
    const id = lookupId.trim();
    if (!id) {
      setSearchError('Enter a variant ID (e.g. an rsID such as rs1042522).');
      return;
    }
    setLookupLoading(true);
    setHits(null);
    setPage(0);
    try {
      const res = await lookupVariant({ variant_id: id, species, api_source: apiSource });
      setHits([res.variant]);
    } catch (e) {
      setSearchError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setHits(null);
    } finally {
      setLookupLoading(false);
    }
  }

  /** `null` when selectable; otherwise the reason it isn't (shown as the
   * disabled button's tooltip). A variant found via ID lookup can land on
   * any chromosome, not necessarily the one the loaded gene is on - unlike
   * a region-search hit, which is always on `data.chrom` by construction
   * (that's what was searched) - so this must check both. */
  function hitSelectDisabledReason(hit: VariantHit): string | null {
    if (!canUseVariantSearch) return "Enable 'Include introns' in step 2 to select a variant.";
    if (hit.chrom && data.chrom && hit.chrom !== data.chrom) return `This variant is on chromosome ${hit.chrom}, not the loaded gene's chromosome (${data.chrom}).`;
    if (localPosForHit(hit) === null) return 'This variant maps outside the loaded gene sequence.';
    if (refAltCandidates(hit) === null && new Set(orientedAlleles(hit)).size < 2) {
      return "This variant's allele data isn't available from the source - add it manually using position/ref/alt below instead.";
    }
    return null;
  }

  /** Ensembl reports `alleles` relative to the reference genome's plus
   * strand, regardless of which strand the loaded transcript is on - but
   * `data.gene_seq` is the transcript's own sense-strand sequence (already
   * reverse-complemented at fetch time for a minus-strand gene). Every
   * allele shown to, or picked by, the user must be expressed in
   * `gene_seq`'s orientation, or a correct SNP on a minus-strand gene looks
   * like a mismatch (its plus-strand base is the complement of what's
   * actually in `gene_seq`) and gets wrongly rejected by the backend's
   * `RefAlleleMismatch` check. `-` (Ensembl's "no base here" placeholder
   * for the deleted/inserted side of an indel) is left as-is - it isn't a
   * sequence to reverse-complement. */
  function orientedAlleles(hit: VariantHit): string[] {
    if (data.strand !== '-') return hit.alleles;
    return hit.alleles.map((a) => (a === '-' ? a : reverseComplement(a)));
  }

  function localPosForHit(hit: VariantHit): number | null {
    if (!canUseVariantSearch) return null;
    if (hit.chrom && data.chrom && hit.chrom !== data.chrom) return null;
    const local = data.strand === '-' ? data.gene_end_genomic - hit.end : hit.start - data.gene_start_genomic;
    if (local < 0 || local >= data.gene_seq.length) return null;
    return local;
  }

  /** The *actual* template base at this hit's position (ground truth from
   * `data.gene_seq`, never trusted from the provider's allele order - see
   * `VariantHit.alleles`'s doc) as ref, and every other reported allele as
   * a possible alt - so the UI never has to ask the user to disambiguate
   * ref/alt for a plain biallelic SNP, only to pick among alts when a site
   * genuinely has more than one. `null` when unavailable (off-sequence/
   * wrong chromosome, matching `localPosForHit`), when this isn't a clean
   * set of single-base alleles (an indel), or when none of the reported
   * alleles differ from the true ref (a mapping/strand mismatch). */
  function refAltCandidates(hit: VariantHit): { ref: string; alts: string[] } | null {
    const local = localPosForHit(hit);
    if (local === null) return null;
    const alleles = orientedAlleles(hit);
    if (alleles.length === 0 || !alleles.every(isSingleBase)) return null;
    const trueRef = (data.gene_seq[local] || '').toUpperCase();
    if (!isSingleBase(trueRef)) return null;
    const alts = [...new Set(alleles.map((a) => a.toUpperCase()).filter((a) => a !== trueRef))];
    if (alts.length === 0) return null;
    return { ref: trueRef, alts };
  }

  /** Classic notation for a search/lookup hit, before the user has picked
   * which allele is ref/alt. `null` when `refAltCandidates` can't determine
   * one (see its doc). */
  function snpNameForHit(hit: VariantHit): string | null {
    const local = localPosForHit(hit);
    const candidates = refAltCandidates(hit);
    if (local === null || candidates === null) return null;
    return `${candidates.ref}${local + 1}${candidates.alts.join('/')}`;
  }

  /** A hit's frequency, merging what the search/lookup response already
   * carried (populated for `lookupVariant` results, always `null` for
   * `searchVariants` results - see `VariantHit.minor_allele_freq`) with any
   * on-demand fetch the user triggered for it. `fetched: false` means
   * neither source has an answer yet, so the cell should offer to fetch. */
  function resolvedFreq(h: VariantHit): { value: number | null; minorAllele: string | null; loading: boolean; fetched: boolean } {
    const local = frequencies[h.id];
    if (local) return { value: local.value, minorAllele: local.minorAllele, loading: local.loading, fetched: !local.loading };
    if (h.minor_allele_freq !== null) return { value: h.minor_allele_freq, minorAllele: h.minor_allele, loading: false, fetched: true };
    return { value: null, minorAllele: null, loading: false, fetched: false };
  }

  async function fetchFrequency(h: VariantHit) {
    if (resolvedFreq(h).loading) return;
    setFrequencies((prev) => ({ ...prev, [h.id]: { loading: true, value: null, minorAllele: null } }));
    try {
      const res = await lookupVariant({ variant_id: h.id, species, api_source: apiSource });
      setFrequencies((prev) => ({ ...prev, [h.id]: { loading: false, value: res.variant.minor_allele_freq, minorAllele: res.variant.minor_allele } }));
    } catch {
      // Leave it fetchable again rather than stuck on a failed attempt.
      setFrequencies((prev) => {
        const next = { ...prev };
        delete next[h.id];
        return next;
      });
    }
  }

  const allColumns: { key: string; column: Column<VariantHit> }[] = [
    { key: 'id', column: { header: 'ID', render: (h) => h.id, className: 'font-mono', width: '10%', sortValue: (h) => h.id } },
    { key: 'name', column: { header: 'Name', render: (h) => snpNameForHit(h) ?? '-', className: 'font-mono', width: '8%', sortValue: (h) => snpNameForHit(h) } },
    { key: 'position', column: { header: 'Position', render: (h) => `chr${h.chrom}:${h.start === h.end ? h.start : `${h.start}-${h.end}`}`, width: '12%', sortValue: (h) => h.start } },
    { key: 'alleles', column: { header: 'Alleles', render: (h) => orientedAlleles(h).join('/'), className: 'font-mono', width: '8%' } },
    { key: 'consequence', column: { header: 'Consequence', render: (h) => (h.consequence_type || '-').replace(/_/g, ' '), width: '15%', sortValue: (h) => h.consequence_type } },
    {
      key: 'clinical',
      column: {
        header: 'Clinical significance',
        render: (h) => (h.clinical_significance.length ? h.clinical_significance.join(', ') : '-'),
        width: '15%',
        sortValue: (h) => (h.clinical_significance.length ? h.clinical_significance.join(', ') : null),
      },
    },
    {
      key: 'frequency',
      column: {
        header: 'Frequency',
        width: '11%',
        sortValue: (h) => resolvedFreq(h).value,
        render: (h) => {
          const f = resolvedFreq(h);
          if (f.loading) return <span className="text-xs text-ink-faint">…</span>;
          if (f.fetched) return f.value !== null ? `${f.minorAllele ? `${f.minorAllele}: ` : ''}${(f.value * 100).toFixed(2)}%` : '-';
          return (
            <Button size="sm" onClick={() => void fetchFrequency(h)}>
              Fetch
            </Button>
          );
        },
      },
    },
    {
      key: 'select',
      column: {
        header: 'Select',
        width: '19%',
        render: (h) => {
          const candidates = refAltCandidates(h);
          const alleles = orientedAlleles(h);
          const altOptions = candidates ? candidates.alts : alleles;
          return (
            <div>
              {selectedVariants.some((v) => v.key === h.id) ? (
                <Badge tone="success">Added</Badge>
              ) : expandedHitId !== h.id ? (
                <Button size="sm" disabled={hitSelectDisabledReason(h) !== null} title={hitSelectDisabledReason(h) ?? undefined} onClick={() => setExpandedHitId(h.id)}>
                  Select
                </Button>
              ) : (
                <div className="flex w-full max-w-[10rem] flex-col gap-1">
                  <div className="flex items-center gap-1">
                    <span className="shrink-0 text-xs">Ref:</span>
                    {/* Ground truth once `refAltCandidates` can determine it
                     * (from `data.gene_seq`, not the provider) - offering it
                     * as an editable select would just invite a mismatch the
                     * backend rejects anyway, see `orientedAlleles`'s doc. */}
                    {candidates ? (
                      <span className="font-mono text-xs">{candidates.ref}</span>
                    ) : (
                      <select
                        aria-label="Ref allele"
                        className="min-w-0 flex-1 rounded border border-line-strong bg-surface px-1 py-0.5 text-xs text-ink"
                        value={hitRefAllele[h.id] ?? alleles[0] ?? ''}
                        onChange={(e) => setHitRefAllele((prev) => ({ ...prev, [h.id]: e.target.value }))}
                      >
                        {alleles.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="shrink-0 text-xs">Alt:</span>
                    {/* Multiple options here means a genuinely multi-allelic
                     * site - the user picks which alt they mean. */}
                    <select
                      aria-label="Alt allele"
                      className="min-w-0 flex-1 rounded border border-line-strong bg-surface px-1 py-0.5 text-xs text-ink"
                      value={hitAltAllele[h.id] ?? altOptions[0] ?? ''}
                      onChange={(e) => setHitAltAllele((prev) => ({ ...prev, [h.id]: e.target.value }))}
                    >
                      {altOptions.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button size="sm" variant="primary" className="mt-1" onClick={() => confirmHitSelection(h)}>
                    Add Variant
                  </Button>
                </div>
              )}
            </div>
          );
        },
      },
    },
  ];
  const visibleColumns = allColumns.filter((c) => !hiddenColumns.has(c.key));

  const sortedHits = (() => {
    if (!hits) return [] as VariantHit[];
    const activeColumn = sort ? visibleColumns[sort.columnIndex]?.column : undefined;
    if (activeColumn?.sortValue) return sortByColumn(hits, activeColumn.sortValue, sort!.direction);
    return [...hits].sort((a, b) => dangerScore(a) - dangerScore(b));
  })();
  const totalPages = Math.max(1, Math.ceil(sortedHits.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const pagedHits = sortedHits.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);
  const pageMissingFreq = pagedHits.some((h) => !resolvedFreq(h).fetched);

  /** Fetches frequency for the current page one row at a time (not
   * `Promise.all`) - same rate-limiting rationale as `runDesign`'s
   * sequential `/design_arms` calls: Ensembl itself is already rate-limited
   * server-side, so firing a page's worth of lookups concurrently just
   * queues up with no real speedup. */
  async function showFrequencyForPage() {
    setBulkFreqLoading(true);
    for (const h of pagedHits) {
      if (!resolvedFreq(h).fetched) await fetchFrequency(h);
    }
    setBulkFreqLoading(false);
  }

  function toggleColumn(key: string) {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(HIDDEN_COLUMNS_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
    setSort(null); // column indices shift when visibility changes
  }

  function handleSortChange(columnIndex: number) {
    setSort((prev) => {
      if (!prev || prev.columnIndex !== columnIndex) return { columnIndex, direction: 'asc' };
      if (prev.direction === 'asc') return { columnIndex, direction: 'desc' };
      return null;
    });
  }

  /** Adding a variant clears stale design output rather than the selection
   * list itself - each addition is meant to accumulate a batch, and
   * previous results no longer match the (now different) batch about to be
   * designed. */
  function addVariant(v: SelectedVariant) {
    setDesignError(null);
    setResults([]);
    setSelectedVariants((prev) => (prev.some((p) => p.key === v.key) ? prev : [...prev, v]));
  }

  function removeVariant(key: string) {
    setResults([]);
    setSelectedVariants((prev) => prev.filter((v) => v.key !== key));
  }

  function confirmHitSelection(hit: VariantHit) {
    const reason = hitSelectDisabledReason(hit);
    const local = localPosForHit(hit);
    if (reason !== null || local === null) {
      setSearchError(reason ?? 'This variant maps outside the loaded gene sequence.');
      return;
    }
    const candidates = refAltCandidates(hit);
    const alleles = orientedAlleles(hit);
    const ref = candidates?.ref ?? hitRefAllele[hit.id] ?? alleles[0] ?? '';
    const alt = hitAltAllele[hit.id] ?? candidates?.alts[0] ?? alleles[1] ?? '';
    if (!ref || !alt || ref === alt) {
      setSearchError('Pick two distinct alleles (ref and alt) before using this variant.');
      return;
    }
    addVariant({ key: hit.id, label: hit.id, pos: local, refAllele: ref, altAllele: alt });
    setExpandedHitId(null);
  }

  function useManualVariant() {
    setDesignError(null);
    if (!manualRef.trim() || !manualAlt.trim()) {
      setDesignError('Enter both a ref and an alt allele.');
      return;
    }
    const ref = manualRef.trim().toUpperCase();
    const alt = manualAlt.trim().toUpperCase();
    if (ref === alt) {
      setDesignError('Ref and alt alleles must differ.');
      return;
    }
    addVariant({ key: `manual-${manualPos}-${ref}-${alt}`, label: `Manual (pos ${manualPos})`, pos: manualPos, refAllele: ref, altAllele: alt });
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

  /** Designs every selected variant, one request at a time (not
   * `Promise.all`) - each `/design_arms` call is a CPU-bound primer3 search
   * on the server (`spawn_blocking`), so firing a batch's worth of them
   * concurrently would just queue up behind the same thread pool with no
   * real speedup, for no benefit over sequential requests with visible
   * per-variant progress. */
  async function runDesign() {
    setDesignError(null);
    if (selectedVariants.length === 0) {
      setDesignError('Select at least one variant first (via search or manual entry).');
      return;
    }
    setDesignLoading(true);
    setResults([]);
    const outcomes: DesignOutcome[] = [];
    for (const variant of selectedVariants) {
      try {
        const res = await designArms({
          sequence: data.gene_seq,
          variant_pos: variant.pos,
          ref_allele: variant.refAllele,
          alt_allele: variant.altAllele,
          mismatch_enabled: mismatchEnabled,
          mismatch_offset: mismatchOffset,
          engine,
        });
        outcomes.push({ variant, response: res });
      } catch (e) {
        outcomes.push({ variant, error: e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e) });
      }
      setResults([...outcomes]);
    }
    const firstOk = outcomes.find((o) => o.response);
    if (firstOk?.response) {
      selectAllele('ref', firstOk.response.ref_primer);
      selectAllele('alt', firstOk.response.alt_primer);
      const firstCommon = firstOk.response.common_candidates[0];
      if (firstCommon) {
        selectCommon(firstCommon);
        setUsedCommonKey(`${firstOk.variant.key}:${firstCommon.sequence}`);
      }
    }
    setDesignLoading(false);
  }

  return (
    <div>
      <div className="mb-6 rounded-md border border-line bg-surface-2 p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Search known variants ({apiSource === 'ncbi' ? 'NCBI dbSNP' : 'Ensembl'})</h3>
        {!canUseVariantSearch && (
          <div className="mb-3 rounded-md border border-warning/25 bg-warning-subtle p-2 text-sm text-warning">
            Enable &ldquo;Include introns&rdquo; in step 2 to search for known variants (genomic coordinates only map exactly onto the intron-inclusive gene sequence). You can still enter a variant manually below.
          </div>
        )}
        <div className="mb-3 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Region start (bp, 0-based into gene sequence)">
            <TextInput type="number" min={0} value={regionStart} onChange={(e) => setRegionStart(parseInt(e.target.value, 10) || 0)} className="tabular-nums" />
          </Field>
          <Field label="Region end (bp, exclusive)">
            <TextInput type="number" min={0} value={regionEnd} onChange={(e) => setRegionEnd(parseInt(e.target.value, 10) || 0)} className="tabular-nums" />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" disabled={searchLoading} onClick={() => void runSearch()} className="w-full">
              {searchLoading ? 'Searching…' : 'Search Variants'}
            </Button>
          </div>
        </div>

        <div className="my-3 flex items-center gap-3 text-xs text-ink-faint">
          <div className="flex-1 border-t border-line" />
          or look up a specific variant by its database ID
          <div className="flex-1 border-t border-line" />
        </div>
        <div className="flex gap-3">
          <TextInput
            type="text"
            placeholder="e.g. rs1042522…"
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runLookupById();
            }}
            className="flex-1 font-mono"
          />
          <Button variant="primary" disabled={lookupLoading} onClick={() => void runLookupById()}>
            {lookupLoading ? 'Looking up…' : 'Look Up'}
          </Button>
        </div>

        {searchError && <div role="alert" className="mt-3 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{searchError}</div>}

        {hits && hits.length > 0 && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-muted">
              <span>
                {sort ? `Sorted by ${visibleColumns[sort.columnIndex]?.column.header ?? ''} (${sort.direction})` : 'Sorted by clinical relevance'}, showing {pagedHits.length ? clampedPage * pageSize + 1 : 0}-{clampedPage * pageSize + pagedHits.length} of {sortedHits.length}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {pageMissingFreq && (
                  <Button size="sm" disabled={bulkFreqLoading} onClick={() => void showFrequencyForPage()}>
                    {bulkFreqLoading ? 'Fetching frequencies…' : 'Show frequency'}
                  </Button>
                )}
                <div className="relative">
                  <Button size="sm" aria-haspopup="menu" aria-expanded={columnsMenuOpen} onClick={() => setColumnsMenuOpen((o) => !o)}>
                    Columns ▾
                  </Button>
                  {columnsMenuOpen && (
                    <div className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-line bg-surface p-2 shadow-md">
                      {allColumns.map((c) => (
                        <label key={c.key} className="flex cursor-pointer items-center gap-2 px-1 py-1 text-xs text-ink">
                          <input type="checkbox" checked={!hiddenColumns.has(c.key)} onChange={() => toggleColumn(c.key)} className="h-3.5 w-3.5 accent-accent" />
                          {c.column.header}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <label className="text-xs text-ink-muted" htmlFor="arms-page-size">Per page:</label>
                <select
                  id="arms-page-size"
                  className="h-7 rounded-md border border-line-strong bg-surface px-2 text-xs text-ink"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <Button size="sm" disabled={clampedPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  Prev
                </Button>
                <span className="text-xs tabular-nums text-ink-muted">
                  Page {clampedPage + 1} of {totalPages}
                </span>
                <Button size="sm" disabled={clampedPage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                  Next
                </Button>
              </div>
            </div>
            <ResultsTable rows={pagedHits} keyOf={(h) => h.id} columns={visibleColumns.map((c) => c.column)} sort={sort} onSortChange={handleSortChange} />
          </>
        )}
      </div>

      <div className="mb-6 rounded-md border border-line bg-surface-2 p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Or enter a variant manually</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Position (bp, 0-based into gene sequence)">
            <TextInput type="number" min={0} value={manualPos} onChange={(e) => setManualPos(parseInt(e.target.value, 10) || 0)} className="tabular-nums" />
          </Field>
          <Field label="Ref allele">
            <TextInput type="text" value={manualRef} onChange={(e) => setManualRef(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Alt allele">
            <TextInput type="text" value={manualAlt} onChange={(e) => setManualAlt(e.target.value)} className="font-mono" />
          </Field>
        </div>
        <Button variant="primary" className="mt-3" onClick={useManualVariant}>
          Add Variant
        </Button>
      </div>

      {selectedVariants.length > 0 && (
        <div className="mb-4 rounded-md border border-line bg-surface-2 p-3 text-sm text-ink-muted">
          <p className="mb-2 font-semibold text-ink">Selected variants ({selectedVariants.length}):</p>
          <ul className="space-y-1">
            {selectedVariants.map((v) => {
              const notation = snpNotation(v.pos, v.refAllele, v.altAllele);
              return (
                <li key={v.key} className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-mono">{v.label}</span>
                    {notation && (
                      <>
                        {' '}
                        (<span className="font-mono">{notation}</span>)
                      </>
                    )}
                    : position <strong className="font-medium text-ink">{v.pos}</strong>, ref <strong className="font-mono font-medium text-ink">{v.refAllele}</strong> / alt <strong className="font-mono font-medium text-ink">{v.altAllele}</strong>
                  </span>
                  <button className="shrink-0 text-xs font-medium text-danger hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => removeVariant(v.key)}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Checkbox label={<span className="font-medium">Add destabilizing mismatch</span>} checked={mismatchEnabled} onChange={(e) => setMismatchEnabled(e.target.checked)} />
        {mismatchEnabled && (
          <Field label="Mismatch offset (bases from 3' end)">
            <TextInput type="number" min={1} value={mismatchOffset} onChange={(e) => setMismatchOffset(parseInt(e.target.value, 10) || 1)} className="w-32 tabular-nums" />
          </Field>
        )}
        <EngineSelect value={engine} onChange={setEngine} />
        <Button variant="primary" disabled={designLoading || selectedVariants.length === 0} onClick={() => void runDesign()}>
          {designLoading ? `Designing… (${results.length}/${selectedVariants.length})` : `Design ARMS Primers${selectedVariants.length > 1 ? ` (${selectedVariants.length})` : ''}`}
        </Button>
      </div>

      {designError && <div role="alert" className="mb-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{designError}</div>}

      {results.length > 0 && (
        <div className="mt-2 space-y-8">
          {results.map((outcome, i) => {
            const notation = snpNotation(outcome.variant.pos, outcome.variant.refAllele, outcome.variant.altAllele);
            return (
            <div key={outcome.variant.key} className={i > 0 ? 'border-t border-line pt-6' : ''}>
              <h3 className="mb-2 text-sm font-semibold text-ink">
                {outcome.variant.label}
                {notation && <span className="font-mono"> ({notation})</span>}, position {outcome.variant.pos}, ref <span className="font-mono">{outcome.variant.refAllele}</span> / alt{' '}
                <span className="font-mono">{outcome.variant.altAllele}</span>
              </h3>

              {outcome.error && <div role="alert" className="mb-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{outcome.error}</div>}

              {outcome.response && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {[
                      { label: 'Ref', p: outcome.response.ref_primer, which: 'ref' as const },
                      { label: 'Alt', p: outcome.response.alt_primer, which: 'alt' as const },
                    ].map(({ label, p, which }) => (
                      <div key={which} className="rounded-lg border border-line bg-surface p-3">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-sm font-semibold text-ink">
                            {label} allele ({which === 'ref' ? outcome.variant.refAllele : outcome.variant.altAllele})
                          </span>
                          <Button size="sm" variant="primary" onClick={() => selectAllele(which, p)}>
                            Highlight
                          </Button>
                        </div>
                        <p className="break-all font-mono text-sm text-ink">{p.sequence}</p>
                        <p className="mt-1 text-xs tabular-nums text-ink-muted">
                          Len {p.length} · Tm {fmt(p.tm)} · GC% {fmt(p.gc_percent)} · Hairpin {yesNo(p.hairpin.structure_found)} · Homodimer {yesNo(p.homodimer.structure_found)}
                          {p.mismatch_position !== null && <> · Mismatch at position {p.mismatch_position}</>}
                        </p>
                      </div>
                    ))}
                  </div>

                  <h4 className="mb-2 mt-4 text-sm font-semibold text-ink">Common Primer Candidates</h4>
                  <div className="mb-4 rounded-md border border-line bg-surface-2 p-2 text-sm text-ink-muted">
                    The common primer is shared by both reactions (ref-specific + common, alt-specific + common); selecting one row highlights it for both.
                    {results.length > 1 && ' Highlighting works one variant at a time: picking here overwrites the sequence view\u2019s current highlight.'}
                  </div>
                  <div className="space-y-2">
                    {outcome.response.common_candidates.map((c, ci) => (
                      <PrimerCard
                        key={`${outcome.variant.key}-c-${ci}-${c.sequence}`}
                        index={ci}
                        primer={c}
                        idtCredentials={idtCredentials}
                        selected={usedCommonKey === `${outcome.variant.key}:${c.sequence}`}
                        onUse={() => {
                          selectCommon(c);
                          setUsedCommonKey(`${outcome.variant.key}:${c.sequence}`);
                        }}
                        extra={
                          <div className="mt-2 border-t border-line pt-2 text-[13px] text-ink-muted">
                            Product: <span className="font-mono tabular-nums">{c.product_size_ref} bp</span> (ref) / <span className="font-mono tabular-nums">{c.product_size_alt} bp</span> (alt)
                          </div>
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
