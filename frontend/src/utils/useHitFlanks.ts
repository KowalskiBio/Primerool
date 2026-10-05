import { useEffect, useState } from 'react';
import { fetchBlastHitFlanks, type BlastHit, type HitFlanks } from '../api/blast';

/** Fetched hit flanks, cached per hit identity (accession + both
 * coordinate pairs): re-opening a primer's results, or the same hit
 * appearing again (in another table or dialog), never refetches. A failed
 * fetch is cached as `null` — the affected primer ends just stay
 * unaligned. */
const flankCache = new Map<string, HitFlanks | null>();

export function flankKey(hit: BlastHit): string {
  return `${hit.accession}|${hit.hit_from}|${hit.hit_to}|${hit.query_from}|${hit.query_to}|${hit.query_len}`;
}

/** A hit whose alignment does not cover the primer's full length — the
 * ones the flank fetch upgrades from blank dangling ends to real
 * mismatching bases. */
function hasDanglingEnds(hit: BlastHit): boolean {
  return Boolean(hit.qseq && hit.hseq && (hit.query_from > 1 || hit.query_to < hit.query_len));
}

export interface HitFlankState {
  /** Flanks fetched so far, by `flankKey`. */
  flanks: Record<string, HitFlanks | null>;
  /** How many of `hits` have dangling ends, and how many are resolved. */
  needed: number;
  resolved: number;
}

/** Fetches the subject bases for the dangling primer ends of each of
 * `hits` (sequentially — they all hit NCBI efetch) so their alignments
 * cover the primer's full length. Cached across renders and callers; hits
 * render with blank dangling ends first and re-render as flanks land.
 * `hits` must be referentially stable across renders (a prop or memo). */
export function useHitFlanks(hits: BlastHit[], enabled: boolean): HitFlankState {
  const [flanks, setFlanks] = useState<Record<string, HitFlanks | null>>({});

  useEffect(() => {
    if (!enabled) return;
    const needed = hits.filter(hasDanglingEnds);
    const sync = () => setFlanks(Object.fromEntries(needed.filter((h) => flankCache.has(flankKey(h))).map((h) => [flankKey(h), flankCache.get(flankKey(h)) ?? null])));
    sync();
    const pending = needed.filter((h) => !flankCache.has(flankKey(h)));
    if (!pending.length) return;
    let cancelled = false;
    (async () => {
      for (const hit of pending) {
        const key = flankKey(hit);
        if (!flankCache.has(key)) {
          try {
            flankCache.set(key, await fetchBlastHitFlanks(hit));
          } catch {
            flankCache.set(key, null);
          }
        }
        if (cancelled) return;
        sync();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hits, enabled]);

  const needed = enabled ? new Set(hits.filter(hasDanglingEnds).map(flankKey)).size : 0;
  return { flanks, needed, resolved: Math.min(Object.keys(flanks).length, needed) };
}
