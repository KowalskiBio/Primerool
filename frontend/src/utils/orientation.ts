import type { SequenceData } from '../api/sequence';

/** Whether `data`'s sequence is on the genomic plus strand, regardless of
 * the transcript's own biological strand. Every `/get_sequence` call this
 * app makes asks for `orient_plus: true`, so loaded genes are always
 * plus-oriented; the fallback (`data.strand !== '-'`) keeps older responses
 * and locally-built custom-sequence data (no `plus_oriented` field) working
 * with their historical semantics — a custom sequence is its own plus
 * strand by definition, and a strand-less one has nothing to flip.
 *
 * All local↔genomic coordinate math and allele-orientation logic keys off
 * THIS, not `data.strand`: a minus-strand gene whose map is plus-oriented
 * uses plus-strand arithmetic even though `data.strand === '-'`. */
export function isPlusOriented(data: SequenceData): boolean {
  return data.plus_oriented ?? data.strand !== '-';
}
