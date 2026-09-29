import type { ReactNode } from 'react';
import type { SequenceData } from '../api/sequence';

/** One-line orientation note for a sequence map's header. Plus-strand
 * genes (and custom sequences) get nothing - the map reads the way every
 * other tool shows it. A minus-strand gene's map is still rendered on the
 * genomic plus strand (see `utils/orientation.ts`), so its mRNA reads
 * right-to-left - say so, or the user reads exon 1 at the left edge and
 * forward/reverse primers look flipped (the exact confusion that motivated
 * plus-orientation). A map switched to the minus strand (`plus_oriented`
 * explicitly false - see `utils/strandFlip.ts`) says that instead. */
export default function OrientationNote({ data, children }: { data: SequenceData; children?: ReactNode }) {
  if (data.plus_oriented && data.strand === '-') {
    return (
      <p className="mt-1 text-xs text-ink-muted">
        <strong className="font-medium text-ink">{data.gene_name}</strong> is on the minus strand - shown here on the{' '}
        <strong className="font-medium text-ink">genomic plus strand (5&prime;&rarr;3&prime;)</strong>, so its mRNA reads
        right-to-left. Primers are forward/reverse in genomic orientation.
        {children}
      </p>
    );
  }
  if (data.plus_oriented === false && data.strand === '-') {
    return (
      <p className="mt-1 text-xs text-ink-muted">
        <strong className="font-medium text-ink">{data.gene_name}</strong> is on the minus strand - shown here on the{' '}
        <strong className="font-medium text-ink">minus strand (5&prime;&rarr;3&prime;)</strong>, so its mRNA reads
        left-to-right. Primers are forward/reverse in transcript orientation.
        {children}
      </p>
    );
  }
  return null;
}
