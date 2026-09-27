import type { SequenceData } from '../api/sequence';
import { EMPTY_SELECTIONS, type Selections } from './regionMapping';

/** Browser-storage key for the primer sets made on one loaded sequence.
 * Everything that shifts `Selection` coordinates is part of it - flank
 * lengths, introns/UTR included - so a set is only ever restored onto the
 * exact view it was made in. `null` (nothing saved) for a pasted custom
 * sequence: it has no stable identity to key on. */
export function primerSetKey(data: SequenceData | null): string | null {
  if (!data || data.transcript_id === 'custom') return null;
  return ['primerool.sets.v1', data.gene_name, data.transcript_id, data.include_introns ? 'i' : '-', data.include_utr ? 'u' : '-', data.upstream_len, data.downstream_len].join('|');
}

/** Storage can be unavailable (private window, blocked site data) - the
 * app then simply starts empty and doesn't remember. */
export function loadPrimerSets(key: string | null): Selections {
  if (!key) return EMPTY_SELECTIONS;
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...EMPTY_SELECTIONS, ...(JSON.parse(raw) as Partial<Selections>) } : EMPTY_SELECTIONS;
  } catch {
    return EMPTY_SELECTIONS;
  }
}

export function savePrimerSets(key: string | null, sets: Selections) {
  if (!key) return;
  try {
    const empty = Object.values(sets).every((s) => s === null);
    if (empty) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(sets));
  } catch {
    // not remembered - see loadPrimerSets
  }
}
