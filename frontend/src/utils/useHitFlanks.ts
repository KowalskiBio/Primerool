import { useEffect, useState } from 'react';
import { fetchBlastHitFlanks, type BlastHit, type HitFlanks } from '../api/blast';

/** Fetched hit flanks, cached per hit identity (accession + both
 * coordinate pairs): re-opening a primer's results, or the same hit
 * appearing again (in another table or dialog), never refetches. A failed
 * (or empty) fetch is cached as `null` — the affected primer ends just
 * stay unaligned. */
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

/** Minimum spacing between flank requests. Each one is an NCBI efetch,
 * and NCBI allows 3 requests/s without an API key - two loops fetching at
 * once (the overview column and a report export) went over it, and the
 * failures came back as empty flanks. */
const MIN_GAP_MS = 400;
/** Pause before the one retry of an empty answer - NCBI's rate limiting
 * also surfaces as one, and usually clears within a second. */
const RETRY_EMPTY_AFTER_MS = 1200;
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
const inFlight = new Map<string, Promise<HitFlanks | null>>();

/** Fetches one hit's flanks through a single app-wide queue (spaced by
 * `MIN_GAP_MS`, duplicate requests shared) into the cache. An empty
 * result - a failed fetch upstream, or no sequence there (a hit at the
 * very end of its record) - is retried once, then cached as `null` like
 * an error, so it shows as unaligned rather than as a successful fetch. */
function fetchFlanksQueued(hit: BlastHit): Promise<HitFlanks | null> {
  const key = flankKey(hit);
  if (flankCache.has(key)) return Promise.resolve(flankCache.get(key) ?? null);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const job = queue.then(async () => {
    let result: HitFlanks | null = null;
    for (let attempt = 0; attempt < 2 && result === null; attempt++) {
      const wait = lastRequestAt + (attempt ? RETRY_EMPTY_AFTER_MS : MIN_GAP_MS) - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      try {
        const f = await fetchBlastHitFlanks(hit);
        result = f.five || f.three ? f : null;
      } catch {
        result = null;
      }
    }
    flankCache.set(key, result);
    inFlight.delete(key);
    return result;
  });
  queue = job.catch(() => undefined);
  inFlight.set(key, job);
  return job;
}

/** A hit's flanks if already fetched (`null` = fetch failed), else
 * `undefined` - the synchronous lookup a report builder uses after
 * `prefetchHitFlanks`. */
export function cachedHitFlanks(hit: BlastHit): HitFlanks | null | undefined {
  return flankCache.get(flankKey(hit));
}

/** Fetches (sequentially, into the shared cache) the flanks of every one
 * of `hits` that has dangling ends and isn't cached yet - for a caller
 * that needs them all before it can proceed, like a report export.
 * `onProgress(done, total)` follows along. Never rejects: a failed fetch
 * is cached as `null`, like the hook does. */
export async function prefetchHitFlanks(hits: BlastHit[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const keys = new Set<string>();
  const pending = hits.filter((h) => {
    const key = flankKey(h);
    if (!hasDanglingEnds(h) || flankCache.has(key) || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  onProgress?.(0, pending.length);
  for (let i = 0; i < pending.length; i++) {
    await fetchFlanksQueued(pending[i]);
    onProgress?.(i + 1, pending.length);
  }
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
        await fetchFlanksQueued(hit);
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
