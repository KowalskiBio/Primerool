// Whether a primer *pair* could amplify something besides its intended
// target: a sequence both primers' BLAST hits land on, bound on opposite
// strands, facing each other, close enough for PCR to span - Primer-BLAST's
// definition of an unintended product. Each primer's own 3'-end verdict
// (see `primerAlignment.ts`) then decides whether that product is likely.

import type { BlastHit, HitFlanks } from '../api/blast';
import { assessPrimerHit, type PrimerHitAssessment, type PrimingLevel } from './primerAlignment';

/** A hit's fetched flanks (see `useHitFlanks`), when known - fills in the
 * primer ends BLAST left unaligned before a hit is judged. */
export type FlanksOf = (hit: BlastHit) => HitFlanks | null | undefined;
const noFlanks: FlanksOf = () => undefined;

/** Longest product counted as amplifiable (Primer-BLAST's default). */
export const MAX_PRODUCT_BP = 4000;
/** Product-size slack within which a shared target "matches" the designed
 * amplicon - almost always a clone or assembly of the target locus itself. */
const SAME_SIZE_SLACK_BP = 2;

export type SharedTargetVerdict = 'amplifies' | 'weak' | 'blocked' | 'no-product';

export interface PrimerOnTarget {
  hit: BlastHit;
  assessment: PrimerHitAssessment | null;
}

export interface SharedTarget {
  accession: string;
  title: string;
  organism: string;
  fwd: PrimerOnTarget;
  rev: PrimerOnTarget;
  /** Product length when the two primers face each other on opposite
   * strands within `MAX_PRODUCT_BP`; `null` when they don't. */
  productSize: number | null;
  /** The hit is the gene of interest itself (by symbol or title). */
  onTarget: boolean;
  /** The product is the designed amplicon's size - most likely the target
   * locus in a genomic clone or assembly rather than a true off-target. */
  sameSizeAsTarget: boolean;
  verdict: SharedTargetVerdict;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `hit` is a record of `gene` itself: its parsed gene symbol, or
 * the symbol as a whole word in the title ("... (TP53), mRNA"). */
export function isGeneHit(hit: BlastHit, gene: string): boolean {
  if (!gene) return false;
  if (hit.gene_symbol && hit.gene_symbol.toUpperCase() === gene.toUpperCase()) return true;
  return new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(gene)}([^A-Za-z0-9-]|$)`, 'i').test(hit.title);
}

/** Where the whole primer sits on the hit sequence: its 5' end and whether
 * it reads along the plus strand - extending BLAST's local alignment over
 * any primer bases it left unaligned. */
function footprint(hit: BlastHit): { fivePrime: number; plus: boolean } {
  const plus = hit.hit_from <= hit.hit_to;
  const lead = hit.query_from - 1;
  return { fivePrime: plus ? hit.hit_from - lead : hit.hit_from + lead, plus };
}

/** PCR product length if one primer binds the plus strand upstream of the
 * other binding the minus strand (3' ends facing), else `null`. */
function productSize(a: BlastHit, aLen: number, b: BlastHit, bLen: number): number | null {
  const fa = footprint(a);
  const fb = footprint(b);
  if (fa.plus === fb.plus) return null;
  const [up, down] = fa.plus ? [fa, fb] : [fb, fa];
  const size = down.fivePrime - up.fivePrime + 1;
  return size >= Math.max(aLen, bLen) && size <= MAX_PRODUCT_BP ? size : null;
}

/** Every sequence both primers hit, each with the product the pair would
 * make there and how likely it is - off-target products first. A hit
 * without an alignment (BLASTed before alignments were returned) counts
 * as able to prime, the cautious reading. Only each hit's best alignment
 * is known, so a second binding site on the same long sequence is not. */
export function findSharedTargets(
  fwdPrimer: string,
  fwdHits: BlastHit[],
  revPrimer: string,
  revHits: BlastHit[],
  gene: string,
  designedSize: number | null,
  flanksOf: FlanksOf = noFlanks,
): SharedTarget[] {
  const revByAccession = new Map(revHits.map((h) => [h.accession, h]));
  const shared: SharedTarget[] = [];
  const seen = new Set<string>();

  for (const fh of fwdHits) {
    const rh = revByAccession.get(fh.accession);
    if (!rh || seen.has(fh.accession)) continue;
    seen.add(fh.accession);
    const fwd = { hit: fh, assessment: assessPrimerHit(fwdPrimer, fh, flanksOf(fh)) };
    const rev = { hit: rh, assessment: assessPrimerHit(revPrimer, rh, flanksOf(rh)) };
    const size = productSize(fh, fwdPrimer.length, rh, revPrimer.length);
    const levels = [fwd.assessment?.level ?? 'risk', rev.assessment?.level ?? 'risk'];
    const verdict: SharedTargetVerdict =
      size === null ? 'no-product' : levels.includes('unlikely') ? 'blocked' : levels.includes('weak') ? 'weak' : 'amplifies';
    shared.push({
      accession: fh.accession,
      title: fh.title,
      organism: fh.organism,
      fwd,
      rev,
      productSize: size,
      onTarget: isGeneHit(fh, gene) || isGeneHit(rh, gene),
      sameSizeAsTarget: size !== null && designedSize !== null && Math.abs(size - designedSize) <= SAME_SIZE_SLACK_BP,
      verdict,
    });
  }

  const rank: Record<SharedTargetVerdict, number> = { amplifies: 0, weak: 1, blocked: 2, 'no-product': 3 };
  return shared.sort(
    (a, b) =>
      Number(a.onTarget) - Number(b.onTarget) ||
      Number(isOffTargetProduct(b)) - Number(isOffTargetProduct(a)) ||
      Number(a.sameSizeAsTarget) - Number(b.sameSizeAsTarget) ||
      rank[a.verdict] - rank[b.verdict],
  );
}

/** A worrying off-target product: not the gene of interest, not the
 * designed amplicon's own size, and both primers able to prime. */
export function isOffTargetProduct(t: SharedTarget): boolean {
  return !t.onTarget && !t.sameSizeAsTarget && (t.verdict === 'amplifies' || t.verdict === 'weak');
}

export interface RankedHit {
  hit: BlastHit;
  assessment: PrimerHitAssessment | null;
}

/** Worst first: a perfect match elsewhere outranks one that can still
 * prime, then weak, then 3'-blocked. No alignment counts as "can prime". */
const SEVERITY: Record<PrimingLevel, number> = { perfect: 0, risk: 1, weak: 2, unlikely: 3 };

/** One primer's hits other than the target, most likely to prime first -
 * skipping the gene of interest and `locusAccessions` (sequences the pair
 * amplifies at the designed size, i.e. clones of the target locus). Ties
 * go to fewer mismatches at the 3' end, then overall, then E-value. */
export function rankOffTargetHits(primer: string, hits: BlastHit[], gene: string, locusAccessions: ReadonlySet<string>, flanksOf: FlanksOf = noFlanks): RankedHit[] {
  return hits
    .filter((h) => !isGeneHit(h, gene) && !locusAccessions.has(h.accession))
    .map((hit) => ({ hit, assessment: assessPrimerHit(primer, hit, flanksOf(hit)) }))
    .sort((a, b) => {
      const sa = a.assessment ? SEVERITY[a.assessment.level] : SEVERITY.risk;
      const sb = b.assessment ? SEVERITY[b.assessment.level] : SEVERITY.risk;
      return (
        sa - sb ||
        (a.assessment?.threePrimeMismatches ?? 0) - (b.assessment?.threePrimeMismatches ?? 0) ||
        (a.assessment?.mismatches ?? 0) - (b.assessment?.mismatches ?? 0) ||
        (a.hit.evalue ?? Infinity) - (b.hit.evalue ?? Infinity)
      );
    });
}

/** The chromosome a BLAST hit title names, if any: "... on chromosome
 * 22q13.1", "Homo sapiens 12 PAC ...", "BAC clone RP11-624A4 from 4, ...". */
export function titleChromosome(title: string): string | null {
  const m = title.match(/chromosome\s+([0-9]{1,2}|X|Y)(?![0-9])/i) ?? title.match(/sapiens\s+([0-9]{1,2}|X|Y)\s+(?:BAC|PAC)\b/i) ?? title.match(/\bfrom\s+([0-9]{1,2}|X|Y)\s*,/i);
  return m?.[1]?.toUpperCase() ?? null;
}

/** One off-target amplicon site: records of the same
 * genomic site (a RefSeqGene and a BAC clone covering it) give the pair
 * the exact same product size, so records are grouped by it. */
export interface AmpliconSite {
  label: string;
  size: number;
  /** Only possible despite a 3'-end mismatch on one of the primers. */
  mismatched3: boolean;
  records: SharedTarget[];
}

export function ampliconSites(off: SharedTarget[]): AmpliconSite[] {
  const groups = new Map<number, SharedTarget[]>();
  for (const t of off) {
    if (t.productSize === null || t.sameSizeAsTarget) continue;
    groups.set(t.productSize, [...(groups.get(t.productSize) ?? []), t]);
  }
  return [...groups.values()]
    .map((records): AmpliconSite => {
      const symbol = records.map((r) => r.fwd.hit.gene_symbol ?? r.rev.hit.gene_symbol).find(Boolean);
      const chrom = records.map((r) => titleChromosome(r.title)).find(Boolean);
      return {
        label: symbol ?? (chrom ? `chr${chrom}` : records[0].accession),
        size: records[0].productSize ?? 0,
        mismatched3: records.every((r) => r.verdict === 'blocked'),
        records,
      };
    })
    .sort((a, b) => Number(a.mismatched3) - Number(b.mismatched3) || a.size - b.size);
}
