/** Plain-text duplex view for a bimolecular (self- or hetero-) dimer —
 * three monospace lines (top strand, bond symbols, bottom strand), using
 * `alignDimer`'s gapped-column alignment so every bond is a real vertical
 * `|`/`:` and any bulge just shows as blank space in whichever strand
 * doesn't have a base there. Chosen over an SVG rendering specifically
 * because plain text is trivially, visibly correct — no geometry to get
 * wrong, no diagonal-line ambiguity to misread. */
import { alignDimer } from '../utils/dimerAlignment';

interface Props {
  seq1: string;
  seq2: string;
  /** Dot-bracket structure over the concatenation `seq1 + seq2`. */
  structure: string;
}

const WATSON_CRICK = new Set(['AT', 'TA', 'AU', 'UA', 'GC', 'CG']);
const WOBBLE = new Set(['GT', 'TG', 'GU', 'UG']);

function bondSymbol(a: string, b: string): string {
  const pair = (a + b).toUpperCase();
  if (WATSON_CRICK.has(pair)) return '|';
  if (WOBBLE.has(pair)) return ':';
  return ' ';
}

export default function DimerAscii({ seq1, seq2, structure }: Props) {
  if (!seq1 || !seq2 || !structure || structure.length !== seq1.length + seq2.length) {
    return <div className="text-[13px] text-zinc-400 italic">Invalid dimer structure</div>;
  }

  const { topCol, botCol, pairs, totalCols } = alignDimer(seq1, seq2, structure);
  if (pairs.length === 0) {
    return <div className="text-[13px] text-zinc-400 italic">No inter-strand base pairs predicted</div>;
  }

  const topRow = new Array(totalCols).fill(' ');
  for (let i = 0; i < seq1.length; i++) topRow[topCol[i]] = seq1[i].toUpperCase();

  const botRow = new Array(totalCols).fill(' ');
  for (let i = 0; i < seq2.length; i++) botRow[botCol[i]] = seq2[i].toUpperCase();

  const bondRow = new Array(totalCols).fill(' ');
  for (const { topIdx, botIdx } of pairs) {
    bondRow[topCol[topIdx]] = bondSymbol(seq1[topIdx], seq2[botIdx]);
  }

  const topLine = `5' ${topRow.join('')} 3'`;
  const bondLine = `   ${bondRow.join('')}`;
  const botLine = `3' ${botRow.join('')} 5'`;

  return (
    <div className="bg-zinc-50 dark:bg-zinc-900/50 rounded p-2 overflow-x-auto">
      <pre className="font-mono text-[13px] text-zinc-700 dark:text-zinc-300 whitespace-pre leading-[1.3]">{[topLine, bondLine, botLine].join('\n')}</pre>
    </div>
  );
}
