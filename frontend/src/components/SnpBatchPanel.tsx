import { useMemo, useRef, useState } from 'react';
import { importSnpDocx, importSnpText, type SnpBlock } from '../api/snpImport';
import { analyzePrimer, designFlanking, type DesignEngine } from '../api/design';
import { searchGene } from '../api/gene';
import { getSequence } from '../api/sequence';
import { ApiError } from '../api/client';
import EngineSelect from './EngineSelect';
import SnpAmpliconMap, { type PlacedAmplicon } from './SnpAmpliconMap';
import SnpGeneMapModal from './SnpGeneMapModal';
import PrimerStructureModal from './PrimerStructureModal';
import AmpliconDetailModal from './AmpliconDetailModal';
import Section from './ui/Section';
import Badge from './ui/Badge';
import Button from './ui/Button';
import Field from './ui/Field';
import TextInput, { controlClasses } from './ui/TextInput';
import { fmt } from '../utils/format';
import { localGenePos, SNP_WORKFLOW_SPECIES } from '../utils/variantMapping';
import { reverseComplement } from '../utils/dna';

/** Per-rsID result of checking whether it falls inside its gene's
 * *canonical* transcript's exon span - deliberately narrower than
 * `SnpGeneMapModal`'s own all-transcripts search (which exists precisely
 * to recover from this), since the point here is to flag "the canonical
 * transcript alone misses this one", not to say the SNP is unreachable. */
interface CanonicalCheck {
  status: 'checking' | 'done' | 'error';
  inCanonical?: boolean;
  transcriptName?: string;
}

/** What the results table and CSV export actually read off a designed
 * oligo - deliberately narrower than `FlankingOligoResult` (which every
 * auto-picked candidate structurally satisfies, so those assign here with
 * no conversion) so a manually-repositioned primer, which only has a
 * sequence and a re-analyzed Tm, fits the same field without fabricating
 * the rest of primer3's per-candidate metadata. */
interface OligoDisplay {
  sequence: string;
  tm: number | null;
  /** Set when this side's position came from dragging its edge on the
   * amplicon map (`handleManualEdgeEdit`) rather than from the ranked
   * candidate list - shown as a star in the table. */
  manual?: boolean;
}

interface BatchResult {
  status: 'pending' | 'running' | 'done' | 'error';
  fwd?: OligoDisplay;
  rev?: OligoDisplay;
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
  /** Every rsID (including this one) that shares this exact primer pair,
   * because they were close enough to merge into one design (see
   * `buildMergeGroups`) - `undefined`/single-element for an ordinary,
   * unmerged result. The same `BatchResult` object is stored under each
   * member rsID, so this is also how the table/map tell a merged group's
   * rows apart from an incidental identical result. */
  mergedWith?: string[];
}

/** Splices multiple SNP blocks' own 401bp flanking windows into one
 * indexed reference sequence, keyed to real genomic coordinates via each
 * block's `interval_start` - what a merged group's design call needs for
 * one combined forward/reverse flank, and what its placed amplicon needs
 * for a `refSeq` wide enough to draw from (see `SnpAmpliconMap.tsx`).
 * Returns `null` if the group's own windows don't fully cover the
 * combined span - shouldn't happen for blocks the merge threshold judged
 * close enough to pair up (each window reaches 200bp either side), but
 * checked rather than assumed. */
function combineBlockWindows(group: SnpBlock[]): { start: number; chars: string } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const b of group) {
    const refSeq = b.upstream_seq + (b.alleles[0] || 'N') + b.downstream_seq;
    start = Math.min(start, b.interval_start);
    end = Math.max(end, b.interval_start + refSeq.length - 1);
  }
  const chars = new Array<string | undefined>(end - start + 1);
  for (const b of group) {
    const refSeq = b.upstream_seq + (b.alleles[0] || 'N') + b.downstream_seq;
    for (let i = 0; i < refSeq.length; i++) {
      const idx = b.interval_start + i - start;
      if (chars[idx] === undefined) chars[idx] = refSeq[i];
    }
  }
  if (chars.some((c) => c === undefined)) return null;
  return { start, chars: chars.join('') };
}

/** Chains adjacent same-gene, same-chromosome SNPs into one group whenever
 * consecutive positions are within `maxGapBp` of each other - transitively,
 * so three SNPs each under `maxGapBp` from the next all merge into one
 * group even if the first and last are further apart than that on their
 * own. `maxGapBp <= 0` disables merging entirely (every block its own
 * group of one). Designing one shared primer pair for a merged group
 * (rather than one pair per SNP that happens to sit inside another's
 * amplicon anyway) avoids ordering redundant, overlapping primer sets for
 * variants close enough to already share a single PCR product. */
function buildMergeGroups(blocks: SnpBlock[], maxGapBp: number): SnpBlock[][] {
  if (!maxGapBp || maxGapBp <= 0) return blocks.map((b) => [b]);

  const byGeneChrom = new Map<string, SnpBlock[]>();
  for (const b of blocks) {
    const key = `${b.gene}\u0000${b.chrom}`;
    const list = byGeneChrom.get(key);
    if (list) list.push(b);
    else byGeneChrom.set(key, [b]);
  }

  const groups: SnpBlock[][] = [];
  for (const list of byGeneChrom.values()) {
    const sorted = [...list].sort((a, b) => a.position - b.position);
    let current: SnpBlock[] = [];
    for (const b of sorted) {
      if (current.length > 0 && b.position - current[current.length - 1].position <= maxGapBp) {
        current.push(b);
      } else {
        if (current.length > 0) groups.push(current);
        current = [b];
      }
    }
    if (current.length > 0) groups.push(current);
  }

  // Cosmetic only (doesn't affect correctness): keeps the table's
  // top-to-bottom "running…" progress roughly matching row order instead
  // of jumping around by gene/chromosome grouping order.
  const orderOf = new Map(blocks.map((b, i) => [b.rsid, i]));
  groups.sort((a, b) => (orderOf.get(a[0].rsid) ?? 0) - (orderOf.get(b[0].rsid) ?? 0));
  return groups;
}

/** Picks one (forward, reverse) candidate pair jointly, in ranked order,
 * for two constraints that can't be resolved independently per side since
 * they're properties of the *pair*: clearing every `avoid` position (a
 * primer sitting on an unrelated listed SNP can silently fail to anneal
 * on the allele it doesn't match) and - if `maxProduct` is set - not
 * producing a longer product than that. Scans `fwdCandidates` outer,
 * `revCandidates` inner, both already primer3-ranked, so the first pair
 * satisfying everything is also the best-ranked one that does. Relaxes
 * one constraint at a time when nothing satisfies both (avoid first, kept
 * over length, since an unresolved overlap risks a silent allele dropout
 * a sequencer won't flag, where an oversized product is at least visible
 * on a gel/trace) before finally falling back to the top-ranked pair
 * outright, so a design is always returned - `tooLong`/`avoidUnresolved`
 * report which constraints, if any, that final pick still fails. */
function pickPair<T extends { interval: [number, number] }>(
  fwdCandidates: T[],
  revCandidates: T[],
  fwdSpan: (c: T) => [number, number],
  revSpan: (c: T) => [number, number],
  ampOf: (fwd: T, rev: T) => { ampStart: number; ampEnd: number; productSize: number },
  avoid: { rsid: string; pos: number }[],
  maxProduct: number | undefined,
): { fwd: T; fwdIndex: number; rev: T; revIndex: number; ampStart: number; ampEnd: number; productSize: number; avoidHits0: { rsid: string; pos: number }[]; avoidUnresolved: { rsid: string; pos: number }[]; tooLong: boolean } | null {
  if (!fwdCandidates.length || !revCandidates.length) return null;

  const hitsOf = (span: [number, number]) => avoid.filter((a) => a.pos >= span[0] && a.pos <= span[1]);
  const avoidHits0 = [...hitsOf(fwdSpan(fwdCandidates[0])), ...hitsOf(revSpan(revCandidates[0]))];

  for (const requireLength of maxProduct !== undefined ? [true, false] : [false]) {
    for (let i = 0; i < fwdCandidates.length; i++) {
      if (hitsOf(fwdSpan(fwdCandidates[i])).length > 0) continue;
      for (let j = 0; j < revCandidates.length; j++) {
        if (hitsOf(revSpan(revCandidates[j])).length > 0) continue;
        const amp = ampOf(fwdCandidates[i], revCandidates[j]);
        if (requireLength && amp.productSize > maxProduct!) continue;
        return { fwd: fwdCandidates[i], fwdIndex: i, rev: revCandidates[j], revIndex: j, ...amp, avoidHits0, avoidUnresolved: [], tooLong: maxProduct !== undefined && amp.productSize > maxProduct };
      }
    }
  }

  // Nothing clears `avoid` at all (with or without the length cap) - fall
  // back to the top-ranked pair, reporting every constraint it still fails.
  const amp = ampOf(fwdCandidates[0], revCandidates[0]);
  return { fwd: fwdCandidates[0], fwdIndex: 0, rev: revCandidates[0], revIndex: 0, ...amp, avoidHits0, avoidUnresolved: avoidHits0, tooLong: maxProduct !== undefined && amp.productSize > maxProduct };
}

/** Every pair of same-chromosome amplicons whose [ampStart, ampEnd] spans
 * intersect - the actual PCR products, not the raw 200bp report windows
 * (those already get their own "shares this window with" flag from
 * `other_targets`). Two rsIDs merged into the same design (`mergedWith`)
 * are excluded from each other's flags - they share the exact same
 * amplicon on purpose, that's not a clash to warn about. */
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
      if (a.r.mergedWith?.includes(b.rsid)) continue;
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
  const [mergeDistance, setMergeDistance] = useState('20');
  const [maxProduct, setMaxProduct] = useState('');
  const [engine, setEngine] = useState<DesignEngine>('strider');
  const [results, setResults] = useState<Record<string, BatchResult>>({});
  const [running, setRunning] = useState(false);
  const [openGene, setOpenGene] = useState<string | null>(null);
  const [openPrimer, setOpenPrimer] = useState<{ label: string; forward: string; reverse: string } | null>(null);
  // Identifies the open amplicon by one of its member rsIDs, rather than
  // storing the `PlacedAmplicon` object itself - `placedAmplicons` below
  // is rebuilt fresh every render, so a stored object snapshot would go
  // stale the moment `AmpliconDetailModal` commits an edit; looking it up
  // by key on every render (see `openAmpliconData`) keeps it live instead.
  const [openAmpliconKey, setOpenAmpliconKey] = useState<string | null>(null);
  const [canonicalChecks, setCanonicalChecks] = useState<Record<string, CanonicalCheck>>({});
  // Bumped on every new import - `checkCanonicalCoverage`'s in-flight async
  // work checks this before each write so a stale check from a superseded
  // import can't clobber a fresh one (same purpose as the `cancelled` flag
  // `SnpGeneMapModal.tsx`'s fetch effect uses, just not effect-scoped since
  // this runs from event handlers, not an effect).
  const checkGenRef = useRef(0);

  /** For every unique gene in `newBlocks`, fetches that gene's canonical
   * transcript once and flags each of its blocks whose genomic position
   * falls outside that transcript's exon span - "not in canonical", shown
   * as a badge in the results table. Deliberately checks only the
   * canonical transcript (see `CanonicalCheck`'s doc); the flag exists to
   * point at `SnpGeneMapModal`'s own broader search, not to duplicate it. */
  async function checkCanonicalCoverage(newBlocks: SnpBlock[]) {
    const gen = ++checkGenRef.current;
    const byGene = new Map<string, SnpBlock[]>();
    for (const b of newBlocks) {
      const list = byGene.get(b.gene);
      if (list) list.push(b);
      else byGene.set(b.gene, [b]);
    }

    for (const [gene, geneBlocks] of byGene) {
      if (checkGenRef.current !== gen) return;
      setCanonicalChecks((prev) => {
        const next = { ...prev };
        for (const b of geneBlocks) next[b.rsid] = { status: 'checking' };
        return next;
      });

      let data = null;
      for (const apiSource of ['ncbi', 'ensembl'] as const) {
        try {
          const found = await searchGene({ gene_name: gene, species: SNP_WORKFLOW_SPECIES, api_source: apiSource });
          const canonical = found.transcripts.find((t) => t.is_canonical) || found.transcripts[0];
          if (!canonical) continue;
          data = await getSequence({
            gene_name: gene,
            transcript_id: canonical.id,
            species: SNP_WORKFLOW_SPECIES,
            api_source: apiSource,
            upstream_bp: 200,
            downstream_bp: 200,
            include_introns: true,
            include_utr: false,
          });
          break;
        } catch {
          // try the next source
        }
      }
      if (checkGenRef.current !== gen) return;

      setCanonicalChecks((prev) => {
        const next = { ...prev };
        for (const b of geneBlocks) {
          next[b.rsid] = data ? { status: 'done', inCanonical: localGenePos(data, b.position) !== null, transcriptName: data.transcript_name } : { status: 'error' };
        }
        return next;
      });
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportError(null);
    setImporting(true);
    setResults({});
    setCanonicalChecks({});
    try {
      const base64 = await readFileAsBase64(file);
      const res = await importSnpDocx(base64);
      setBlocks(res.blocks);
      void checkCanonicalCoverage(res.blocks);
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
    setCanonicalChecks({});
    try {
      const res = await importSnpText(pastedText);
      setBlocks(res.blocks);
      void checkCanonicalCoverage(res.blocks);
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
    const maxGap = mergeDistance.trim() ? parseInt(mergeDistance, 10) : 0;
    const groups = buildMergeGroups(blocks, maxGap);

    const next: Record<string, BatchResult> = {};
    for (const b of blocks) next[b.rsid] = { status: 'pending' };
    setResults(next);

    const positionByRsid = new Map(blocks.map((b) => [b.rsid, b.position]));

    for (const group of groups) {
      for (const b of group) setResults((prev) => ({ ...prev, [b.rsid]: { status: 'running' } }));
      try {
        // A group of one behaves exactly as before (this branch's
        // `combinedStart`/`lastPos`/flanks reduce to that single block's
        // own `interval_start`/`position`/`upstream_seq`/`downstream_seq`);
        // a merged group instead flanks the whole span from its leftmost
        // to its rightmost SNP with one shared forward/reverse pair.
        let combinedStart: number;
        let lastPos: number;
        let upstream: string;
        let downstream: string;
        if (group.length === 1) {
          const b = group[0];
          combinedStart = b.interval_start;
          lastPos = b.position;
          upstream = b.upstream_seq;
          downstream = b.downstream_seq;
        } else {
          const combined = combineBlockWindows(group);
          if (!combined) throw new Error("Merged SNPs' windows don't fully cover the combined region");
          const first = group[0];
          const last = group[group.length - 1];
          combinedStart = combined.start;
          lastPos = last.position;
          upstream = combined.chars.substring(0, first.position - combined.start);
          downstream = combined.chars.substring(last.position + 1 - combined.start);
        }

        const res = await designFlanking(upstream, downstream, engine, window);
        const fwdCandidates = res.primers.forward.primers;
        const revCandidates = res.primers.reverse.primers;
        if (!fwdCandidates.length || !revCandidates.length) {
          for (const b of group) setResults((prev) => ({ ...prev, [b.rsid]: { status: 'error', error: 'No primers found in window' } }));
          continue;
        }

        // Prefer a candidate PAIR that both clears every other listed SNP
        // known to share this window (any member's `other_targets`,
        // excluding this group's own rsIDs - those are inside the
        // amplicon on purpose) - a primer sitting on an unrelated
        // polymorphism can silently fail to anneal on the allele it
        // doesn't match (allele dropout) - and, if a max product size is
        // set, doesn't produce a longer product than that. Genomic
        // coordinates: the forward primer's 5' end sits at
        // `combinedStart + fwd.interval[0]`; the reverse primer's 5' end
        // sits `rev.interval[1]` bases after the group's rightmost variant
        // (for a group of one, `combinedStart`/`lastPos` are just that
        // block's own `interval_start`/`position`, matching the original
        // single-SNP formula exactly).
        const groupRsids = new Set(group.map((b) => b.rsid));
        const avoid = group
          .flatMap((b) => b.other_targets)
          .filter((rsid) => !groupRsids.has(rsid))
          .map((rsid) => ({ rsid, pos: positionByRsid.get(rsid) }))
          .filter((x): x is { rsid: string; pos: number } => x.pos !== undefined);
        const maxProductBp = maxProduct.trim() ? parseInt(maxProduct, 10) : undefined;
        const pick = pickPair(
          fwdCandidates,
          revCandidates,
          (c) => [combinedStart + c.interval[0], combinedStart + c.interval[1] - 1],
          (c) => [lastPos + 1 + c.interval[0], lastPos + c.interval[1]],
          (fwdC, revC) => {
            const ampStart = combinedStart + fwdC.interval[0];
            const ampEnd = lastPos + revC.interval[1];
            return { ampStart, ampEnd, productSize: ampEnd - ampStart + 1 };
          },
          avoid,
          maxProductBp,
        )!;
        const fwd = pick.fwd;
        const rev = pick.rev;

        const notes: BatchResult['notes'] = [];
        if (pick.avoidUnresolved.length) {
          notes.push({ tone: 'danger', text: `Overlaps ${[...new Set(pick.avoidUnresolved.map((h) => h.rsid))].join(', ')} (no candidate pair clears it; review manually)` });
        } else if (pick.avoidHits0.length) {
          notes.push({ tone: 'accent', text: `Used alt candidates (fwd #${pick.fwdIndex + 1}, rev #${pick.revIndex + 1}) to avoid ${[...new Set(pick.avoidHits0.map((h) => h.rsid))].join(', ')}` });
        }
        if (pick.tooLong) {
          notes.push({ tone: 'danger', text: `Product ${pick.productSize} bp exceeds the ${maxProductBp} bp max (no candidate pair fits; review manually)` });
        }

        // The server's heterodimer check is only ever computed for the
        // top-ranked forward/reverse pair — if either side switched
        // candidates to avoid a neighbor or fit the length cap, that check
        // no longer applies to the pair actually used, so don't report it
        // as if it did.
        const usedDefaultPair = pick.fwdIndex === 0 && pick.revIndex === 0;
        const result: BatchResult = {
          status: 'done',
          fwd,
          rev,
          productSize: pick.productSize,
          ampStart: pick.ampStart,
          ampEnd: pick.ampEnd,
          pairFound: usedDefaultPair ? (res.primers.pair_metrics?.heterodimer.structure_found ?? false) : undefined,
          pairDg: usedDefaultPair ? (res.primers.pair_metrics?.heterodimer.dg ?? null) : undefined,
          notes,
          mergedWith: group.length > 1 ? group.map((b) => b.rsid) : undefined,
        };
        setResults((prev) => {
          const nextResults = { ...prev };
          for (const b of group) nextResults[b.rsid] = result;
          return nextResults;
        });
      } catch (err) {
        const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
        for (const b of group) setResults((prev) => ({ ...prev, [b.rsid]: { status: 'error', error: message } }));
      }
    }
    setRunning(false);
  }

  /** Pure geometry step shared by `handleManualEdgeEdit` (one side) and
   * `handleManualMove` (both sides at once, same shift): clamps the
   * requested genomic edge to a same-length primer that still fits inside
   * `b`'s own flank, and slices that primer's sequence out (reverse-
   * complemented for the reverse side, whose flank reads 5'->3' away from
   * the variant on the plus strand). Returns `null` only when there's no
   * room at all for a primer this long in that flank - never true for a
   * flank this app itself designed from, but a drag is free-form input. */
  function computeSideAt(b: SnpBlock, side: 'start' | 'end', len: number, genomicPos: number): { sequence: string; ampEdge: number } | null {
    if (side === 'start') {
      if (len > b.upstream_seq.length) return null;
      const s = Math.max(0, Math.min(genomicPos - b.interval_start, b.upstream_seq.length - len));
      return { sequence: b.upstream_seq.substring(s, s + len), ampEdge: b.interval_start + s };
    }
    if (len > b.downstream_seq.length) return null;
    const e0 = Math.max(len, Math.min(genomicPos - b.position, b.downstream_seq.length));
    return { sequence: reverseComplement(b.downstream_seq.substring(e0 - len, e0)), ampEdge: b.position + e0 };
  }

  /** Recomputes one side of an already-designed pair after its primer
   * segment is dragged on the amplicon map (see `SnpAmpliconMap`'s
   * `onEdgeDrag`, which for a merged group passes the *leftmost* member's
   * rsID for `'start'` and the *rightmost*'s for `'end'` - the same blocks
   * `runBatch`'s merged design path itself anchored the shared forward/
   * reverse primer to, so `computeSideAt` looking `b` up from `rsid` alone
   * is correct for either group size). Re-analyzed for Tm/GC/hairpin via
   * the same `/analyze_primer` route `SequenceViewer.tsx`'s interactive
   * drag editing already uses, then written to every rsID sharing this
   * result (`mergedWith`), not just `rsid` itself. Silently a no-op if the
   * drag would collapse or invert the amplicon (dragged past the other
   * primer), or if this block isn't a finished result. */
  async function handleManualEdgeEdit(rsid: string, side: 'start' | 'end', genomicPos: number) {
    const b = (blocks || []).find((x) => x.rsid === rsid);
    const r = results[rsid];
    if (!b || !r || r.status !== 'done' || !r.fwd || !r.rev || r.ampStart === undefined || r.ampEnd === undefined) return;

    const len = side === 'start' ? r.fwd.sequence.length : r.rev.sequence.length;
    const computed = computeSideAt(b, side, len, genomicPos);
    if (!computed) return;
    const newAmpStart = side === 'start' ? computed.ampEdge : r.ampStart;
    const newAmpEnd = side === 'end' ? computed.ampEdge : r.ampEnd;
    if (newAmpStart >= newAmpEnd) return;

    const productSize = newAmpEnd - newAmpStart + 1;
    const analysis = await analyzePrimer({ sequence: computed.sequence }).catch(() => null);
    const oligo: OligoDisplay = { sequence: computed.sequence, tm: analysis?.tm ?? null, manual: true };
    const groupRsids = r.mergedWith && r.mergedWith.length > 1 ? r.mergedWith : [rsid];

    setResults((prev) => {
      const prevR = prev[rsid];
      if (!prevR) return prev; // superseded by a re-import mid-drag
      const updated: BatchResult = {
        ...prevR,
        fwd: side === 'start' ? oligo : prevR.fwd,
        rev: side === 'end' ? oligo : prevR.rev,
        ampStart: newAmpStart,
        ampEnd: newAmpEnd,
        productSize,
        // The server's heterodimer check was only ever computed for the
        // pair this replaces - no longer applicable to the manual pair.
        pairFound: undefined,
        pairDg: undefined,
      };
      const next = { ...prev };
      for (const id of groupRsids) next[id] = updated;
      return next;
    });
  }

  /** Recomputes BOTH primers after the whole amplicon bar is dragged (see
   * `SnpAmpliconMap`'s `onAmpliconMove`) - the same per-side clamp/slice/
   * re-analyze `handleManualEdgeEdit` does for one edge, applied to both
   * ends with the same shift. `startRsid`/`endRsid` are the group's own
   * leftmost/rightmost member (identical to each other for an unmerged
   * SNP) - see `SnpAmpliconMap.tsx`'s note on why the specific member, not
   * the group's joined display label, must be used. A no-op if either side
   * has nowhere valid to land, or the shift would invert the amplicon. */
  async function handleManualMove(startRsid: string, endRsid: string, deltaBp: number) {
    if (!deltaBp) return;
    const bStart = (blocks || []).find((x) => x.rsid === startRsid);
    const bEnd = (blocks || []).find((x) => x.rsid === endRsid);
    const r = results[startRsid];
    if (!bStart || !bEnd || !r || r.status !== 'done' || !r.fwd || !r.rev || r.ampStart === undefined || r.ampEnd === undefined) return;

    const fwdComputed = computeSideAt(bStart, 'start', r.fwd.sequence.length, r.ampStart + deltaBp);
    const revComputed = computeSideAt(bEnd, 'end', r.rev.sequence.length, r.ampEnd + deltaBp);
    if (!fwdComputed || !revComputed) return;
    const newAmpStart = fwdComputed.ampEdge;
    const newAmpEnd = revComputed.ampEdge;
    if (newAmpStart >= newAmpEnd) return;

    const productSize = newAmpEnd - newAmpStart + 1;
    const [fwdAnalysis, revAnalysis] = await Promise.all([analyzePrimer({ sequence: fwdComputed.sequence }).catch(() => null), analyzePrimer({ sequence: revComputed.sequence }).catch(() => null)]);
    const fwdOligo: OligoDisplay = { sequence: fwdComputed.sequence, tm: fwdAnalysis?.tm ?? null, manual: true };
    const revOligo: OligoDisplay = { sequence: revComputed.sequence, tm: revAnalysis?.tm ?? null, manual: true };
    const groupRsids = r.mergedWith && r.mergedWith.length > 1 ? r.mergedWith : [startRsid];

    setResults((prev) => {
      const prevR = prev[startRsid];
      if (!prevR) return prev; // superseded by a re-import mid-drag
      const updated: BatchResult = {
        ...prevR,
        fwd: fwdOligo,
        rev: revOligo,
        ampStart: newAmpStart,
        ampEnd: newAmpEnd,
        productSize,
        pairFound: undefined,
        pairDg: undefined,
      };
      const next = { ...prev };
      for (const id of groupRsids) next[id] = updated;
      return next;
    });
  }

  /** Opens `PrimerStructureModal` for the pair a clicked primer belongs to
   * (both sequences are needed regardless of which one was clicked, since
   * the modal also checks their heterodimer). `side` (which end was
   * actually clicked) doesn't change what's shown - both primers'
   * hairpin/self-dimer plus their shared heterodimer are always all
   * shown together. */
  function handlePrimerClick(rsid: string) {
    const b = (blocks || []).find((x) => x.rsid === rsid);
    const r = results[rsid];
    if (!b || !r?.fwd || !r?.rev) return;
    setOpenPrimer({ label: b.rsid, forward: r.fwd.sequence, reverse: r.rev.sequence });
  }

  /** Opens `AmpliconDetailModal` for the amplicon whose body (not a primer
   * segment) was clicked on the map. */
  function handleAmpliconClick(amplicon: PlacedAmplicon) {
    setOpenAmpliconKey(amplicon.variants[0]?.rsid ?? null);
  }

  /** Writes a primer edit committed inside `AmpliconDetailModal`'s
   * embedded sequence map straight into `results` - unlike
   * `handleManualEdgeEdit`/`handleManualMove`, `SequenceViewer` has
   * already done its own clamping, slicing, and `/analyze_primer` call
   * (the main gene workflow's own drag-to-edit mechanism), so this just
   * records what it produced rather than recomputing anything itself. */
  function handleAmpliconDetailEdit(groupRsids: string[], side: 'start' | 'end', newAmpEdge: number, sequence: string, tm: number | null) {
    const oligo: OligoDisplay = { sequence, tm, manual: true };
    setResults((prev) => {
      const first = groupRsids[0];
      const prevR = first ? prev[first] : undefined;
      if (!prevR || prevR.ampStart === undefined || prevR.ampEnd === undefined) return prev;
      const newAmpStart = side === 'start' ? newAmpEdge : prevR.ampStart;
      const newAmpEnd = side === 'end' ? newAmpEdge : prevR.ampEnd;
      if (newAmpStart >= newAmpEnd) return prev;
      const updated: BatchResult = {
        ...prevR,
        fwd: side === 'start' ? oligo : prevR.fwd,
        rev: side === 'end' ? oligo : prevR.rev,
        ampStart: newAmpStart,
        ampEnd: newAmpEnd,
        productSize: newAmpEnd - newAmpStart + 1,
        pairFound: undefined,
        pairDg: undefined,
      };
      const next = { ...prev };
      for (const id of groupRsids) next[id] = updated;
      return next;
    });
  }

  function exportCsv() {
    if (!blocks) return;
    const header = ['gene', 'rsid', 'chrom', 'position', 'alleles', 'other_targets', 'merged_with', 'forward_primer', 'forward_tm', 'reverse_primer', 'reverse_tm', 'product_size', 'amplicon_start', 'amplicon_end', 'amplicon_overlaps', 'primer_notes', 'heterodimer_found', 'heterodimer_dg', 'status'];
    const rows = blocks.map((b) => {
      const r = results[b.rsid];
      return [
        b.gene,
        b.rsid,
        b.chrom,
        b.position,
        b.alleles.join('/'),
        b.other_targets.join(';'),
        (r?.mergedWith || []).filter((id) => id !== b.rsid).join(';'),
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

  // One `PlacedAmplicon` per *design*, not per block - a merged group's
  // members all point at the exact same `BatchResult` object (see
  // `runBatch`), so the first one seen claims the group and the rest are
  // skipped rather than drawing the identical amplicon on top of itself.
  const placedAmplicons: PlacedAmplicon[] = (() => {
    const done = (blocks || [])
      .map((b) => ({ b, r: results[b.rsid] }))
      .filter(
        (x): x is { b: SnpBlock; r: BatchResult & { ampStart: number; ampEnd: number; productSize: number; fwd: OligoDisplay; rev: OligoDisplay } } =>
          x.r?.status === 'done' && x.r.ampStart !== undefined && x.r.ampEnd !== undefined && x.r.productSize !== undefined && x.r.fwd !== undefined && x.r.rev !== undefined,
      );

    const seen = new Set<string>();
    const placed: PlacedAmplicon[] = [];
    for (const { b, r } of done) {
      if (seen.has(b.rsid)) continue;
      const groupRsids = r.mergedWith && r.mergedWith.length > 1 ? r.mergedWith : [b.rsid];
      const groupBlocks = groupRsids.map((id) => (blocks || []).find((x) => x.rsid === id)).filter((x): x is SnpBlock => x !== undefined);
      for (const id of groupRsids) seen.add(id);

      const combined = groupBlocks.length > 1 ? combineBlockWindows(groupBlocks) : null;
      const ownRefSeq = b.upstream_seq + (b.alleles[0] || 'N') + b.downstream_seq;

      placed.push({
        rsid: groupBlocks.map((x) => x.rsid).join('+'),
        gene: b.gene,
        chrom: b.chrom,
        ampStart: r.ampStart,
        ampEnd: r.ampEnd,
        productSize: r.productSize,
        intervalStart: combined ? combined.start : b.interval_start,
        refSeq: combined ? combined.chars : ownRefSeq,
        variants: groupBlocks.map((x) => ({ rsid: x.rsid, position: x.position, alleles: x.alleles })),
        fwd: r.fwd,
        rev: r.rev,
      });
    }
    return placed;
  })();

  const openAmpliconData = openAmpliconKey ? (placedAmplicons.find((a) => a.variants.some((v) => v.rsid === openAmpliconKey)) ?? null) : null;

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
              <Field label="Merge SNPs within (bp on the same gene; 0 = never)">
                <TextInput
                  type="number"
                  min={0}
                  placeholder="e.g. 20"
                  value={mergeDistance}
                  onChange={(e) => setMergeDistance(e.target.value)}
                  className="w-56 tabular-nums"
                />
              </Field>
              <Field label="Max amplicon length (bp; blank = no limit)">
                <TextInput
                  type="number"
                  min={1}
                  placeholder="e.g. 260 for 2x150bp reads…"
                  value={maxProduct}
                  onChange={(e) => setMaxProduct(e.target.value)}
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
                    // Once this SNP has a finished design, a row opens the
                    // full amplicon detail (gene-context sequence map with
                    // both primers highlighted, plus their secondary
                    // structures below) instead of the plain gene overview
                    // - there's nothing primer-specific to show before
                    // that, so it falls back to the overview until then.
                    const hasDesign = r?.status === 'done';
                    return (
                      <tr
                        key={b.rsid}
                        onClick={() => (hasDesign ? setOpenAmpliconKey(b.rsid) : setOpenGene(b.gene))}
                        title={hasDesign ? `Open ${b.rsid}'s amplicon detail (sequence map, primers & structures)` : `Open ${b.gene}'s sequence map`}
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
                          {canonicalChecks[b.rsid]?.status === 'checking' && (
                            <span title="Checking canonical-transcript coverage…" className="ml-1 text-ink-faint">
                              ⋯
                            </span>
                          )}
                          {canonicalChecks[b.rsid]?.status === 'done' && canonicalChecks[b.rsid].inCanonical === false && (
                            <Badge
                              tone="warning"
                              title={`Outside ${canonicalChecks[b.rsid].transcriptName}'s canonical-transcript span - this SNP may still be in the gene under a different transcript. Open the sequence map (click this row) and try the transcript picker there.`}
                              className="ml-1"
                            >
                              not in canonical
                            </Badge>
                          )}
                          {r?.mergedWith && r.mergedWith.filter((id) => id !== b.rsid).length > 0 && (
                            <Badge
                              tone="accent"
                              title={`Within the merge distance of ${r.mergedWith.filter((id) => id !== b.rsid).join(', ')} - one shared primer pair was designed to amplify all of them together.`}
                              className="ml-1"
                            >
                              merged
                            </Badge>
                          )}
                        </td>
                        <td className="px-2 py-2 font-mono tabular-nums">
                          {b.chrom}:{b.position.toLocaleString()}
                        </td>
                        <td className="break-all px-2 py-2 font-mono">
                          {r?.fwd ? (
                            <>
                              {r.fwd.sequence} ({fmt(r.fwd.tm)}°C)
                              {r.fwd.manual && (
                                <span title="Manually repositioned by dragging this amplicon's start on the map - Tm recalculated for this position" className="ml-1 text-accent">
                                  ★
                                </span>
                              )}
                            </>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="break-all px-2 py-2 font-mono">
                          {r?.rev ? (
                            <>
                              {r.rev.sequence} ({fmt(r.rev.tm)}°C)
                              {r.rev.manual && (
                                <span title="Manually repositioned by dragging this amplicon's end on the map - Tm recalculated for this position" className="ml-1 text-accent">
                                  ★
                                </span>
                              )}
                            </>
                          ) : (
                            '-'
                          )}
                        </td>
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
          <SnpAmpliconMap
            amplicons={placedAmplicons}
            overlaps={overlaps}
            onEdgeDrag={(rsid, side, pos) => void handleManualEdgeEdit(rsid, side, pos)}
            onAmpliconMove={(startRsid, endRsid, delta) => void handleManualMove(startRsid, endRsid, delta)}
            onPrimerClick={handlePrimerClick}
            onAmpliconClick={handleAmpliconClick}
          />
        </Section>
      )}

      <SnpGeneMapModal gene={openGene} blocks={openGeneBlocks} onClose={() => setOpenGene(null)} />
      <PrimerStructureModal pair={openPrimer} onClose={() => setOpenPrimer(null)} />
      <AmpliconDetailModal amplicon={openAmpliconData} onPrimerEdit={handleAmpliconDetailEdit} onClose={() => setOpenAmpliconKey(null)} />
    </>
  );
}
