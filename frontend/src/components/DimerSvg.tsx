/**
 * Renders a bimolecular (self- or hetero-) dimer as a clean 2D SVG duplex
 * diagram - the same visual language `HairpinSvg.tsx` uses (colored base
 * circles, WC/wobble-styled bond rungs, 5'/3' labels), built on this app's
 * own `alignDimer` gapped-column layout (`utils/dimerAlignment.ts`) rather
 * than Oligool's plain monospace duplex view (`DimerAscii.tsx`, kept
 * as-is elsewhere) or Oligool's own single-global-shift dimer SVG, which
 * drops or misdraws any bond outside whichever one offset it picked - see
 * `alignDimer`'s own module doc.
 */
import { openSvgInNewTab } from '../utils/openSvgTab';
import { basePairSymbol, baseColor } from '../utils/nucleotideColors';
import { alignDimer } from '../utils/dimerAlignment';

interface Props {
  seq1: string;
  seq2: string;
  /** Dot-bracket structure over the concatenation `seq1 + seq2`. */
  structure: string;
  /** True for print output: never apply dark-mode variants. */
  light?: boolean;
}

// Layout constants deliberately match `HairpinSvg.tsx`'s so the two
// diagram types read as one consistent style.
const MARGIN = 20;
const COL_STEP = 16;
const TOP_Y = 20;
const ROW_GAP = 44;
const BOT_Y = TOP_Y + ROW_GAP;
const BASE_R = 8;
const HALO_R = 5.5;
const BASE_FONT = 7.5;

export default function DimerSvg({ seq1, seq2, structure, light = false }: Props) {
  if (!seq1 || !seq2 || !structure || structure.length !== seq1.length + seq2.length) {
    return <div className={`text-[13px] italic py-1 ${light ? 'text-zinc-400' : 'text-ink-faint'}`}>Invalid dimer structure</div>;
  }

  const { topCol, botCol, pairs } = alignDimer(seq1, seq2, structure);
  if (pairs.length === 0) {
    return <div className={`text-[13px] italic py-1 ${light ? 'text-zinc-400' : 'text-ink-faint'}`}>No inter-strand base pairs predicted</div>;
  }

  const x = (col: number) => MARGIN + col * COL_STEP;
  const topPos = topCol.map((c) => ({ x: x(c), y: TOP_Y }));
  const botPos = botCol.map((c) => ({ x: x(c), y: BOT_Y }));

  const elements: React.ReactElement[] = [];

  // Backbone: one line per consecutive same-strand pair of bases.
  for (let i = 0; i < seq1.length - 1; i++) {
    elements.push(<line key={`bb1-${i}`} x1={topPos[i].x} y1={topPos[i].y} x2={topPos[i + 1].x} y2={topPos[i + 1].y} stroke={light ? '#94a3b8' : 'var(--ink-faint)'} strokeWidth={1} opacity={0.35} />);
  }
  for (let i = 0; i < seq2.length - 1; i++) {
    elements.push(<line key={`bb2-${i}`} x1={botPos[i].x} y1={botPos[i].y} x2={botPos[i + 1].x} y2={botPos[i + 1].y} stroke={light ? '#94a3b8' : 'var(--ink-faint)'} strokeWidth={1} opacity={0.35} />);
  }

  // Bond rungs - always vertical (`alignDimer` guarantees a paired base's
  // top/bottom columns match), so no diagonal-line ambiguity to misread.
  for (const { topIdx, botIdx } of pairs) {
    const sym = basePairSymbol(seq1[topIdx], seq2[botIdx]);
    if (sym === 'none') continue;
    const a = topPos[topIdx];
    const b = botPos[botIdx];
    elements.push(
      <line
        key={`bond-${topIdx}-${botIdx}`}
        x1={a.x}
        y1={a.y + BASE_R + 1}
        x2={b.x}
        y2={b.y - BASE_R - 1}
        stroke={sym === 'wc' ? 'var(--accent)' : 'var(--warning)'}
        strokeWidth={1.5}
        opacity={sym === 'wc' ? 0.6 : 0.5}
        strokeDasharray={sym === 'wc' ? undefined : '2,2'}
      />,
    );
  }

  // Bases (drawn last so they sit on top of lines).
  for (let i = 0; i < seq1.length; i++) {
    const p = topPos[i];
    const base = seq1[i];
    elements.push(
      <g key={`t-${i}`}>
        <circle cx={p.x} cy={p.y} r={HALO_R} fill={baseColor(base)} opacity={0.18} />
        <text x={p.x} y={p.y + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={BASE_FONT} fontFamily="monospace" fontWeight="bold" fill={baseColor(base)}>
          {base.toUpperCase()}
        </text>
      </g>,
    );
  }
  for (let i = 0; i < seq2.length; i++) {
    const p = botPos[i];
    const base = seq2[i];
    elements.push(
      <g key={`b-${i}`}>
        <circle cx={p.x} cy={p.y} r={HALO_R} fill={baseColor(base)} opacity={0.18} />
        <text x={p.x} y={p.y + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={BASE_FONT} fontFamily="monospace" fontWeight="bold" fill={baseColor(base)}>
          {base.toUpperCase()}
        </text>
      </g>,
    );
  }

  // 5'/3' labels - the top strand reads 5'->3' left to right; the bottom
  // strand is aligned antiparallel underneath it, so it reads 3'->5' left
  // to right (its own 5' end lands at the *largest* column - see
  // `alignDimer`'s walk-reversal doc).
  const topXs = topPos.map((p) => p.x);
  const botXs = botPos.map((p) => p.x);
  const topLeftX = Math.min(...topXs);
  const topRightX = Math.max(...topXs);
  const botLeftX = Math.min(...botXs);
  const botRightX = Math.max(...botXs);
  elements.push(
    <text key="t5" x={topLeftX - 16} y={TOP_Y + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={12} fontFamily="sans-serif" fontWeight="bold" fill={light ? '#818cf8' : 'var(--accent)'}>
      5&apos;
    </text>,
  );
  elements.push(
    <text key="t3" x={topRightX + 16} y={TOP_Y + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={12} fontFamily="sans-serif" fontWeight="bold" fill={light ? '#fb923c' : 'var(--ink-muted)'}>
      3&apos;
    </text>,
  );
  elements.push(
    <text key="b3" x={botLeftX - 16} y={BOT_Y + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={12} fontFamily="sans-serif" fontWeight="bold" fill={light ? '#fb923c' : 'var(--ink-muted)'}>
      3&apos;
    </text>,
  );
  elements.push(
    <text key="b5" x={botRightX + 16} y={BOT_Y + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={12} fontFamily="sans-serif" fontWeight="bold" fill={light ? '#818cf8' : 'var(--accent)'}>
      5&apos;
    </text>,
  );

  const minX = Math.min(topLeftX, botLeftX) - 16 - 10;
  const maxX = Math.max(topRightX, botRightX) + 16 + 10;
  const minY = TOP_Y - BASE_R - 8;
  const maxY = BOT_Y + BASE_R + 8;

  return (
    <svg
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      width="100%"
      style={{ maxHeight: '160px' }}
      preserveAspectRatio="xMidYMid meet"
      className="cursor-zoom-in"
      role="button"
      aria-label="Open structure in a new tab"
      onClick={(e) => openSvgInNewTab(e.currentTarget, 'Dimer structure')}
    >
      <title>Click to open in a new tab</title>
      {elements}
    </svg>
  );
}
