import type { Kingdom } from './species';
import { KINGDOM_LABELS } from './species';

/** The organism picker as last used in this browser - the default on the
 * next visit, so a student working on Pseudomonas doesn't start from
 * Human every time. A restored session still wins over it. */
export interface LastOrganism {
  apiSource: 'ensembl' | 'ncbi';
  kingdom: Kingdom;
  speciesValue: string;
  customSpecies: string;
}

const KEY = 'last_organism';

export function readLastOrganism(): Partial<LastOrganism> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LastOrganism> | null;
    if (!saved || typeof saved !== 'object') return {};
    return {
      apiSource: saved.apiSource === 'ensembl' || saved.apiSource === 'ncbi' ? saved.apiSource : undefined,
      kingdom: saved.kingdom && saved.kingdom in KINGDOM_LABELS ? saved.kingdom : undefined,
      speciesValue: typeof saved.speciesValue === 'string' && saved.speciesValue ? saved.speciesValue : undefined,
      customSpecies: typeof saved.customSpecies === 'string' ? saved.customSpecies : undefined,
    };
  } catch {
    return {};
  }
}

export function writeLastOrganism(organism: LastOrganism) {
  try {
    localStorage.setItem(KEY, JSON.stringify(organism));
  } catch {
    // Storage blocked (private mode, quota): just don't remember.
  }
}
