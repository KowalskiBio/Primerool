import type { SequenceData } from '../api/sequence';
import type { Selection } from './regionMapping';

/** A general-design primer as a gene-region selection - what the map
 * draws, and what "Use L"/"Use R" commit. */
export function generalSelection(data: SequenceData, side: 'left' | 'right', interval: [number, number], primerSeq: string): Selection {
  const [start, end] = interval;
  return { region: 'gene', start, end, primerSeq, bindingSeq: (data.gene_seq || '').substring(start, end), source: 'recommended', strand: side === 'left' ? 'F' : 'R' };
}
