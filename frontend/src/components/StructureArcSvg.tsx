import { parseDotBracketPairs } from '../utils/dotBracket';

interface Props {
  /** The full sequence the dot-bracket structure is defined over — for a
   * dimer this is the concatenation `seq1 + seq2`, matching the server's
   * `structure` convention (thermo_core::structure_thermo::dotbracket). */
  sequence: string;
  structure: string;
  /** For a dimer: index into `sequence` where the second strand begins —
   * draws a small visual break so the two strands read as distinct
   * molecules rather than one continuous one. Omit for a hairpin. */
  splitIndex?: number;
}

const CHAR_WIDTH = 15;
const STRAND_GAP = 22;
const BASELINE_Y = 54;
const MAX_ARC_HEIGHT = 42;
const PAIR_COLOR = '#059669'; // emerald-600, distinguishable in both themes

/** Arc diagram: every base laid out left-to-right in sequence order, paired
 * positions connected by an arc above the baseline. Correct for *any*
 * dot-bracket structure (stacks, bulges, interior loops) without needing
 * per-shape layout logic, unlike a rigid two-row "ladder" diagram — the
 * tradeoff Oligool's own DimerSVG/HairpinSVG made differently is not
 * replicated here; this is a fresh, simpler renderer over the same kind of
 * data. */
export default function StructureArcSvg({ sequence, structure, splitIndex }: Props) {
  const pairs = parseDotBracketPairs(structure);
  const n = sequence.length;
  if (n === 0) return null;

  const xOf = (i: number) => 10 + i * CHAR_WIDTH + (splitIndex !== undefined && i >= splitIndex ? STRAND_GAP : 0);
  const width = xOf(n - 1) + CHAR_WIDTH + 10;
  const height = BASELINE_Y + MAX_ARC_HEIGHT + 22;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="max-w-full">
      <line x1={10} y1={BASELINE_Y} x2={xOf(n - 1) + CHAR_WIDTH / 2} y2={BASELINE_Y} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth={1} />
      {splitIndex !== undefined && splitIndex > 0 && splitIndex < n && (
        <text x={(xOf(splitIndex - 1) + CHAR_WIDTH + xOf(splitIndex)) / 2} y={BASELINE_Y - 10} textAnchor="middle" className="fill-slate-400 dark:fill-slate-500 text-[10px]">
          +
        </text>
      )}
      {[...sequence].map((ch, i) => (
        <text key={i} x={xOf(i) + CHAR_WIDTH / 2} y={BASELINE_Y + 15} textAnchor="middle" className="fill-slate-700 dark:fill-slate-200 text-[11px] font-mono">
          {ch}
        </text>
      ))}
      {pairs.map(([i, j], k) => {
        const x1 = xOf(i) + CHAR_WIDTH / 2;
        const x2 = xOf(j) + CHAR_WIDTH / 2;
        const arcHeight = Math.min(MAX_ARC_HEIGHT, Math.abs(x2 - x1) / 2.2);
        const midX = (x1 + x2) / 2;
        return <path key={k} d={`M ${x1} ${BASELINE_Y} Q ${midX} ${BASELINE_Y - arcHeight * 2} ${x2} ${BASELINE_Y}`} fill="none" stroke={PAIR_COLOR} strokeWidth={1.4} opacity={0.75} />;
      })}
    </svg>
  );
}
