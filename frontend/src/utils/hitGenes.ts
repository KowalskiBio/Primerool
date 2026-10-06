import { useEffect, useState } from 'react';
import { fetchGeneAliases, fetchHitGenes, type BlastHit, type GeneAliasesResponse, type HitGene, type HitGenesResponse } from '../api/blast';
import { createHitLookup, enqueueNcbi } from './ncbiLookup';

/** Which gene(s) each hit actually lies in, from its record's feature
 * table over the hit's span - cached per accession + span. `[]` means
 * looked up, nothing annotated there (typical of BAC clones); `null` a
 * failed lookup. */
const hitGenes = createHitLookup<HitGenesResponse, HitGene[]>({
  keyOf: (hit) => `${hit.accession}|${Math.min(hit.hit_from, hit.hit_to)}|${Math.max(hit.hit_from, hit.hit_to)}`,
  needs: (hit) => hit.hit_from > 0 && hit.hit_to > 0 && !hit.direct,
  fetchValue: fetchHitGenes,
  toValue: (r) => (r?.ok ? r.genes : null),
});

export const hitGenesKey = hitGenes.keyOf;
export const cachedHitGenes = hitGenes.cached;
export const prefetchHitGenes = hitGenes.prefetch;

/** Looks up the genes at each of `hits` in the background (see
 * `hitGenes`), re-rendering as they land. `hits` must be referentially
 * stable across renders. */
export function useHitGenes(hits: BlastHit[], enabled: boolean): Record<string, HitGene[] | null> {
  return hitGenes.useLookup(hits, enabled).values;
}

/** A gene's official symbol and other names, per symbol + organism. */
const aliasCache = new Map<string, string[]>();
const aliasInFlight = new Map<string, Promise<string[]>>();

/** The target gene's names (its own symbol first, then NCBI Gene's other
 * names), so a hit labelled GAPD still counts as GAPDH. Falls back to just
 * `symbol` when the lookup fails or the gene is unknown. */
export function fetchTargetNames(symbol: string, organism: string): Promise<string[]> {
  const key = `${symbol.toUpperCase()}|${organism}`;
  const cached = aliasCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = aliasInFlight.get(key);
  if (pending) return pending;
  const job = enqueueNcbi<GeneAliasesResponse>(
    () => fetchGeneAliases(symbol, organism),
    (r) => !r?.ok,
  ).then((r) => {
    const names = [symbol, ...(r?.aliases ?? []).filter((a) => a.toUpperCase() !== symbol.toUpperCase())];
    if (r?.ok) aliasCache.set(key, names);
    aliasInFlight.delete(key);
    return names;
  });
  aliasInFlight.set(key, job);
  return job;
}

/** `fetchTargetNames` as a hook: `[gene]` until the aliases arrive. */
export function useTargetNames(gene: string, organism: string): string[] {
  const [names, setNames] = useState<{ key: string; names: string[] } | null>(null);
  const key = `${gene.toUpperCase()}|${organism}`;
  useEffect(() => {
    if (!gene) return;
    let cancelled = false;
    fetchTargetNames(gene, organism).then((n) => {
      if (!cancelled) setNames({ key, names: n });
    });
    return () => {
      cancelled = true;
    };
  }, [gene, organism, key]);
  return names?.key === key ? names.names : gene ? [gene] : [];
}
