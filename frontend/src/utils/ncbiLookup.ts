import { useEffect, useState } from 'react';
import type { BlastHit } from '../api/blast';

/** Minimum spacing between the app's per-hit NCBI lookups (primer-end
 * flanks, genes at a hit). Each is an NCBI E-utilities request, and NCBI
 * allows 3 requests/s without an API key - two loops fetching at once (the
 * overview column and a report export) went over it, and the refusals
 * came back as empty answers. */
const MIN_GAP_MS = 400;
/** Pause before the one retry of a failed answer - NCBI's rate limiting
 * usually clears within a second. */
const RETRY_AFTER_MS = 1200;
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/** Runs `run` through the single app-wide NCBI queue, spaced by
 * `MIN_GAP_MS`, retrying once if `failed` judges the answer (or a thrown
 * error, as `undefined`) a failure. Resolves to the last answer. */
export function enqueueNcbi<T>(run: () => Promise<T>, failed: (answer: T | undefined) => boolean): Promise<T | undefined> {
  const job = queue.then(async () => {
    let answer: T | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = lastRequestAt + (attempt ? RETRY_AFTER_MS : MIN_GAP_MS) - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      try {
        answer = await run();
      } catch {
        answer = undefined;
      }
      if (!failed(answer)) break;
    }
    return answer;
  });
  queue = job.catch(() => undefined);
  return job;
}

export interface HitLookupState<V> {
  /** Values fetched so far, by the lookup's key. */
  values: Record<string, V | null>;
  /** How many of the hits need a lookup, and how many are done. */
  needed: number;
  resolved: number;
}

export interface HitLookup<V> {
  keyOf: (hit: BlastHit) => string;
  /** A hit's value if already looked up (`null` = failed or nothing
   * there), else `undefined`. */
  cached: (hit: BlastHit) => V | null | undefined;
  /** Looks up every one of `hits` that needs it and isn't cached yet, one
   * by one through the NCBI queue - for a caller that needs them all
   * before it can proceed, like a report export. Never rejects. */
  prefetch: (hits: BlastHit[], onProgress?: (done: number, total: number) => void) => Promise<void>;
  /** Looks up `hits` in the background, re-rendering as values land.
   * `hits` must be referentially stable across renders (a prop or memo). */
  useLookup: (hits: BlastHit[], enabled: boolean) => HitLookupState<V>;
}

/** A cached, NCBI-queued per-hit lookup: `fetchValue` is asked once per
 * key (re-opening a table, or the same hit in another table, dialog or
 * report, reuses the answer); `toValue` turns its answer into the cached
 * value, `null` meaning failed (retried once, then cached as such). */
export function createHitLookup<A, V>(opts: {
  keyOf: (hit: BlastHit) => string;
  needs: (hit: BlastHit) => boolean;
  fetchValue: (hit: BlastHit) => Promise<A>;
  toValue: (answer: A | undefined) => V | null;
}): HitLookup<V> {
  const cache = new Map<string, V | null>();
  const inFlight = new Map<string, Promise<V | null>>();

  const lookup = (hit: BlastHit): Promise<V | null> => {
    const key = opts.keyOf(hit);
    if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const job = enqueueNcbi(
      () => opts.fetchValue(hit),
      (a) => opts.toValue(a) === null,
    ).then((answer) => {
      const value = opts.toValue(answer);
      cache.set(key, value);
      inFlight.delete(key);
      return value;
    });
    inFlight.set(key, job);
    return job;
  };

  const prefetch: HitLookup<V>['prefetch'] = async (hits, onProgress) => {
    const keys = new Set<string>();
    const pending = hits.filter((h) => {
      const key = opts.keyOf(h);
      if (!opts.needs(h) || cache.has(key) || keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    onProgress?.(0, pending.length);
    for (let i = 0; i < pending.length; i++) {
      await lookup(pending[i]);
      onProgress?.(i + 1, pending.length);
    }
  };

  function useLookup(hits: BlastHit[], enabled: boolean): HitLookupState<V> {
    const [values, setValues] = useState<Record<string, V | null>>({});

    useEffect(() => {
      if (!enabled) return;
      const needed = hits.filter(opts.needs);
      const sync = () => setValues(Object.fromEntries(needed.filter((h) => cache.has(opts.keyOf(h))).map((h) => [opts.keyOf(h), cache.get(opts.keyOf(h)) ?? null])));
      sync();
      const pending = needed.filter((h) => !cache.has(opts.keyOf(h)));
      if (!pending.length) return;
      let cancelled = false;
      (async () => {
        for (const hit of pending) {
          await lookup(hit);
          if (cancelled) return;
          sync();
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [hits, enabled]);

    const needed = enabled ? new Set(hits.filter(opts.needs).map(opts.keyOf)).size : 0;
    return { values, needed, resolved: Math.min(Object.keys(values).length, needed) };
  }

  return { keyOf: opts.keyOf, cached: (hit) => cache.get(opts.keyOf(hit)), prefetch, useLookup };
}
