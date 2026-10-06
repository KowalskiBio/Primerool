import { fetchBlastHitFlanks, type BlastHit, type HitFlanks } from '../api/blast';
import { createHitLookup } from './ncbiLookup';

export function flankKey(hit: BlastHit): string {
  return `${hit.accession}|${hit.hit_from}|${hit.hit_to}|${hit.query_from}|${hit.query_to}|${hit.query_len}`;
}

/** A hit whose alignment does not cover the primer's full length — the
 * ones the flank fetch upgrades from blank dangling ends to real
 * mismatching bases. */
function hasDanglingEnds(hit: BlastHit): boolean {
  return Boolean(hit.qseq && hit.hseq && (hit.query_from > 1 || hit.query_to < hit.query_len));
}

/** The subject bases opposite each hit's dangling primer ends, cached per
 * hit identity (accession + both coordinate pairs). An empty answer - a
 * failed fetch upstream, or no sequence there (a hit at the very end of
 * its record) - is retried once, then cached as `null`, so those ends
 * show as unaligned rather than as a successful fetch. */
const flanks = createHitLookup<HitFlanks, HitFlanks>({
  keyOf: flankKey,
  needs: hasDanglingEnds,
  fetchValue: fetchBlastHitFlanks,
  toValue: (f) => (f && (f.five || f.three) ? f : null),
});

/** A hit's flanks if already fetched (`null` = fetch failed), else
 * `undefined` - the synchronous lookup a report builder uses after
 * `prefetchHitFlanks`. */
export const cachedHitFlanks = flanks.cached;

/** Fetches the flanks of every one of `hits` that has dangling ends and
 * isn't cached yet - for a caller that needs them all first, like a
 * report export. `onProgress(done, total)` follows along. */
export const prefetchHitFlanks = flanks.prefetch;

export interface HitFlankState {
  /** Flanks fetched so far, by `flankKey`. */
  flanks: Record<string, HitFlanks | null>;
  /** How many of `hits` have dangling ends, and how many are resolved. */
  needed: number;
  resolved: number;
}

/** Fetches the subject bases for the dangling primer ends of each of
 * `hits` so their alignments cover the primer's full length; hits render
 * with blank dangling ends first and re-render as flanks land. `hits`
 * must be referentially stable across renders (a prop or memo). */
export function useHitFlanks(hits: BlastHit[], enabled: boolean): HitFlankState {
  const { values, needed, resolved } = flanks.useLookup(hits, enabled);
  return { flanks: values, needed, resolved };
}
