import type { SequenceData } from '../api/sequence';
import { EMPTY_SELECTIONS, type Selections } from './regionMapping';

/** Browser-storage key for the primer sets made on one loaded sequence.
 * Everything that shifts `Selection` coordinates is part of it - flank
 * lengths, introns/UTR included - so a set is only ever restored onto the
 * exact view it was made in. A pasted custom sequence is keyed by its
 * bases (length and a hash), so pasting it again brings its sets back. */
export function primerSetKey(data: SequenceData | null): string | null {
  if (!data) return null;
  if (data.transcript_id === 'custom') return ['primerool.sets.v1', 'custom', data.gene_seq.length, fnv1a(data.gene_seq)].join('|');
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

/** 32-bit FNV-1a, as hex - enough to tell pasted sequences apart. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
