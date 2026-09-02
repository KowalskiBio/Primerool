/**
 * Renders an RNA/DNA secondary structure from a sequence + dot-bracket as a
 * clean 2D SVG diagram — ported verbatim from Oligool's `HairpinSVG.tsx`
 * (same layout algorithm, same constants, same visual output), only the
 * prop names changed (`sequence`/`structure`, matching this app's existing
 * `PrimerAnalysis` field names, not Oligool's `seq`/`dotBracket`).
 *
 * Supports any unbranched structure: a single stem-loop with bulges and
 * internal loops, e.g. ..((.((((.....)))).)), as well as multiple independent
 * stem-loops, which are drawn as one connected diagram (stems side by side,
 * joined by the single-stranded backbone running between them). Branched
 * multiloops (sibling stems nested inside an enclosing stem) fall back to
 * per-domain renderings. Pseudoknots fall back to text.
 */
import React from 'react';
import { openSvgInNewTab } from '../utils/openSvgTab';

interface Props {
  sequence: string;
  structure: string;
  /** True for print output: never apply dark-mode variants. */
  light?: boolean;
}

/**
 * Parse a dot-bracket string into all base pairs [i, j] (i < j), sorted by
 * left index. Returns null for unbalanced input, pseudoknots, or a
 * structure without any pairs.
 */
function parseAllPairs(db: string): Array<[number, number]> | null {
  const stack: number[] = [];
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < db.length; i++) {
    const c = db[i];
    if (c === '(') stack.push(i);
    else if (c === ')') {
      const j = stack.pop();
      if (j === undefined) return null; // unbalanced
      pairs.push([j, i]);
    } else if (c !== '.') {
      return null; // pseudoknot / unsupported bracket type
    }
  }
  if (stack.length) return null; // unbalanced
  if (pairs.length === 0) return null; // no structure
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}

/**
 * Group pairs into top-level stem domains: each domain is rooted at a pair
 * not enclosed by any other pair and contains every pair that root encloses.
 * Every domain must itself be a single unbranched stem (strictly nested
 * pairs, so bulges and internal loops are fine). Returns null when a domain
 * nests sibling stems inside it (a branched multiloop), which needs a
 * different layout.
 */
function topLevelDomains(db: string, pairs: Array<[number, number]>): Array<Array<[number, number]>> | null {
  // parent left-index for each opener, -1 at top level
  const parent = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < db.length; i++) {
    if (db[i] === '(') stack.push(i);
    else if (db[i] === ')') {
      const j = stack.pop();
      if (j === undefined) return null;
      parent.set(j, stack.length ? stack[stack.length - 1] : -1);
    }
  }
  const domains = new Map<number, Array<[number, number]>>();
  for (const p of pairs) {
    let root = p[0];
    while (parent.get(root) !== -1) root = parent.get(root)!;
    const list = domains.get(root);
    if (list) list.push(p);
    else domains.set(root, [p]);
  }
  const result: Array<Array<[number, number]>> = [];
  for (const list of domains.values()) {
    // Unbranched stem => lefts strictly increasing AND rights strictly
    // decreasing. Any violation means sibling stems nested inside.
    for (let k = 1; k < list.length; k++) {
      if (!(list[k][0] > list[k - 1][0] && list[k][1] < list[k - 1][1])) {
        return null;
      }
    }
    result.push(list);
  }
  result.sort((a, b) => a[0][0] - b[0][0]);
  return result;
}

/**
 * Split a multiloop dot-bracket into individual single-stem domains.
 *
 * Each domain is a maximal run of properly-nested pairs. When a pair's right
 * index is NOT less than the previous pair's right index, a new stem group
 * begins. Returns null if the structure is a single stem (not a multiloop),
 * unbalanced, or contains unsupported characters.
 */
function splitStemGroups(seq: string, db: string): Array<{ seq: string; dotBracket: string }> | null {
  const stack: number[] = [];
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < db.length; i++) {
    const c = db[i];
    if (c === '(') stack.push(i);
    else if (c === ')') {
      const j = stack.pop();
      if (j === undefined) return null;
      pairs.push([j, i]);
    } else if (c !== '.') return null;
  }
  if (stack.length || pairs.length === 0) return null;

  pairs.sort((a, b) => a[0] - b[0]);

  const groups: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [pairs[0]];
  let prevRight = pairs[0][1];

  for (let k = 1; k < pairs.length; k++) {
    if (pairs[k][1] < prevRight) {
      cur.push(pairs[k]);
      prevRight = pairs[k][1];
    } else {
      groups.push(cur);
      cur = [pairs[k]];
      prevRight = pairs[k][1];
    }
  }
  groups.push(cur);

  if (groups.length <= 1) return null;

  return groups.map((g) => {
    // Within a group, pairs are sorted left-ascending and (by construction of
    // the grouping loop above) strictly nested, so g[0] is always the
    // outermost pair — its right index is the domain's true closing bound,
    // not g[last]'s (which is the innermost pair and closes earliest).
    const start = g[0][0];
    const end = g[0][1];
    return {
      seq: seq.slice(start, end + 1),
      dotBracket: db.slice(start, end + 1),
    };
  });
}

function basePairSymbol(a: string, b: string): 'wc' | 'wobble' | 'none' {
  const pair = (a + b).toUpperCase();
  const watson = ['AT', 'TA', 'AU', 'UA', 'GC', 'CG'];
  const wobble = ['GT', 'TG', 'GU', 'UG'];
  if (watson.includes(pair)) return 'wc';
  if (wobble.includes(pair)) return 'wobble';
  return 'none';
}

function baseColor(b: string): string {
  switch (b.toUpperCase()) {
    case 'A':
      return '#e74c3c'; // red
    case 'T':
    case 'U':
      return '#3498db'; // blue
    case 'G':
      return '#f39c12'; // amber
    case 'C':
      return '#2ecc71'; // green
    default:
      return '#94a3b8';
  }
}

export default function HairpinSvg({ sequence: seq, structure: dotBracket, light = false }: Props) {
  const dk = (darkClass: string): string => (light ? '' : darkClass);
  const valid = seq && dotBracket && seq.length === dotBracket.length;
  const allPairs = valid ? parseAllPairs(dotBracket) : null;
  const domains = allPairs ? topLevelDomains(dotBracket, allPairs) : null;

  if (!domains) {
    const allDots = dotBracket && !dotBracket.includes('(') && !dotBracket.includes(')');
    if (allDots) {
      return <div className={`text-[13px] text-zinc-400 ${dk('dark:text-zinc-500')} italic py-1`}>No secondary structure predicted</div>;
    }
    // Branched multiloop: try splitting into individual stem-loop domains
    // and render each as a separate HairpinSvg side by side. Only recurse
    // into strictly shorter slices so pathological inputs terminate.
    const stemGroups = valid ? splitStemGroups(seq, dotBracket) : null;
    if (stemGroups && stemGroups.length > 1 && stemGroups.every((g) => g.dotBracket.length < dotBracket.length)) {
      return (
        <div className="flex gap-1 items-end justify-center overflow-x-auto">
          {stemGroups.map((g, i) => (
            <HairpinSvg key={i} sequence={g.seq} structure={g.dotBracket} light={light} />
          ))}
        </div>
      );
    }
    // Pseudoknot / unparseable – show dot-bracket
    const blockPairs: string[] = [];
    for (let start = 0; start < Math.max(seq.length, dotBracket.length); start += 50) {
      blockPairs.push(`${seq.slice(start, start + 50)}\n${dotBracket.slice(start, start + 50)}`);
    }
    return <pre className={`font-mono text-[13px] text-zinc-500 ${dk('dark:text-zinc-400')} whitespace-pre-wrap break-all overflow-x-auto`}>{blockPairs.join('\n\n')}</pre>;
  }

  // ── Layout constants ──────────────────────────────
  const baseR = 8; // spacing reference (bond gaps, bounding box)
  const haloR = 5.5; // visible halo radius behind each base letter
  const baseFont = 7.5;
  const stemGap = 36; // horizontal distance between the two stem strands
  const stemStep = 22; // vertical distance between stacked stem pairs
  const bulgeStep = 18; // extra vertical room per unpaired bulge/internal-loop base
  const bulgeOffset = 15; // how far bulge bases bow out from the strand
  const tailStep = 16; // spacing for unpaired backbone bases
  const minDomainGap = 2 * bulgeOffset + 10; // keeps adjacent stems' bulges apart

  const L = seq.length;
  const m = domains.length;
  const stemBottomY = 170;

  // Vertical level of each stem rung (outermost at the shared baseline)
  const domainLevels: number[][] = domains.map((d) => {
    const lv: number[] = new Array(d.length);
    lv[0] = stemBottomY;
    for (let k = 1; k < d.length; k++) {
      const leftGap = d[k][0] - d[k - 1][0] - 1;
      const rightGap = d[k - 1][1] - d[k][1] - 1;
      const gap = Math.max(leftGap, rightGap);
      lv[k] = lv[k - 1] - stemStep - gap * bulgeStep;
    }
    return lv;
  });

  // ── Position every base by sequence index ──────────
  const pos: Array<{ x: number; y: number } | null> = new Array(L).fill(null);

  // 5' tail – horizontal, going left from the first domain's bottom rung
  const leftTailLen = domains[0][0][0]; // indices 0 .. first start-1
  const firstLeftX = 0;
  for (let i = 0; i < leftTailLen; i++) {
    pos[i] = { x: firstLeftX - (leftTailLen - i) * tailStep, y: stemBottomY };
  }

  let cursor = firstLeftX;
  for (let di = 0; di < m; di++) {
    const d = domains[di];
    const n = d.length;
    const levels = domainLevels[di];
    const leftX = cursor;
    const rightX = leftX + stemGap;
    const cx = leftX + stemGap / 2;

    // Stem rungs
    for (let k = 0; k < n; k++) {
      pos[d[k][0]] = { x: leftX, y: levels[k] };
      pos[d[k][1]] = { x: rightX, y: levels[k] };
    }

    // Bulge / internal-loop bases between consecutive rungs
    for (let k = 1; k < n; k++) {
      const yLow = levels[k - 1];
      const yHigh = levels[k];
      // left side: indices d[k-1][0]+1 .. d[k][0]-1
      const lStart = d[k - 1][0] + 1;
      const lEnd = d[k][0] - 1;
      const lCount = lEnd - lStart + 1;
      for (let b = 0; b < lCount; b++) {
        const frac = (b + 1) / (lCount + 1);
        pos[lStart + b] = {
          x: leftX - bulgeOffset,
          y: yLow - (yLow - yHigh) * frac,
        };
      }
      // right side: indices d[k][1]+1 .. d[k-1][1]-1
      const rStart = d[k][1] + 1;
      const rEnd = d[k - 1][1] - 1;
      const rCount = rEnd - rStart + 1;
      for (let b = 0; b < rCount; b++) {
        const frac = (b + 1) / (rCount + 1);
        pos[rStart + b] = {
          x: rightX + bulgeOffset,
          y: yHigh + (yLow - yHigh) * frac,
        };
      }
    }

    // Terminal loop – distributed along a semicircle above the top rung
    const loopLen = d[n - 1][1] - d[n - 1][0] - 1;
    const stemTopY = levels[n - 1];
    const arcCx = cx;
    const arcCy = stemTopY - baseR - 6;
    const arcR = Math.max(stemGap / 2, (loopLen * 9) / Math.PI);
    if (loopLen > 0) {
      const angleStep = Math.PI / (loopLen + 1);
      for (let b = 0; b < loopLen; b++) {
        const angle = Math.PI + angleStep * (b + 1); // π (left) → 2π (right)
        pos[d[n - 1][0] + 1 + b] = {
          x: arcCx + arcR * Math.cos(angle),
          y: arcCy + arcR * Math.sin(angle),
        };
      }
    }

    // Unpaired backbone up to the next domain (or the 3' tail)
    const connStart = d[0][1] + 1;
    const connEnd = di + 1 < m ? domains[di + 1][0][0] - 1 : L - 1;
    const connLen = connEnd - connStart + 1;
    if (di + 1 < m) {
      const gap = connLen > 0 ? Math.max(connLen * tailStep, minDomainGap) : minDomainGap;
      for (let b = 0; b < connLen; b++) {
        const frac = (b + 1) / (connLen + 1);
        pos[connStart + b] = { x: rightX + gap * frac, y: stemBottomY };
      }
      cursor = rightX + gap;
    } else {
      // 3' tail – horizontal, going right from the last domain
      for (let b = 0; b < connLen; b++) {
        pos[connStart + b] = { x: rightX + (b + 1) * tailStep, y: stemBottomY };
      }
    }
  }

  const rightTailLen = L - 1 - domains[m - 1][0][1]; // indices after the last domain

  // ── Build SVG elements ─────────────────────────────
  const elements: React.ReactElement[] = [];

  // Backbone: one continuous polyline through consecutive bases
  for (let i = 0; i < L - 1; i++) {
    const a = pos[i],
      b = pos[i + 1];
    if (!a || !b) continue;
    elements.push(<line key={`bb-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#94a3b8" strokeWidth={1} opacity={0.35} />);
  }

  // Base-pair bonds (rungs)
  for (let di = 0; di < m; di++) {
    const d = domains[di];
    for (let k = 0; k < d.length; k++) {
      const a = pos[d[k][0]]!,
        b = pos[d[k][1]]!;
      const sym = basePairSymbol(seq[d[k][0]], seq[d[k][1]]);
      if (sym === 'none') continue;
      elements.push(
        <line
          key={`bond-${di}-${k}`}
          x1={a.x + baseR + 1}
          y1={a.y}
          x2={b.x - baseR - 1}
          y2={b.y}
          stroke={sym === 'wc' ? '#818cf8' : '#f59e0b'}
          strokeWidth={1.5}
          opacity={sym === 'wc' ? 0.6 : 0.5}
          strokeDasharray={sym === 'wc' ? undefined : '2,2'}
        />
      );
    }
  }

  // Bases (drawn last so they sit on top of lines)
  for (let i = 0; i < L; i++) {
    const p = pos[i];
    if (!p) continue;
    const base = seq[i];
    elements.push(
      <g key={`base-${i}`}>
        <circle cx={p.x} cy={p.y} r={haloR} fill={baseColor(base)} opacity={0.18} />
        <text x={p.x} y={p.y + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={baseFont} fontFamily="monospace" fontWeight="bold" fill={baseColor(base)}>
          {base.toUpperCase()}
        </text>
      </g>
    );
  }

  // 5' / 3' labels
  const fivePrimeX = pos[0]!.x - (leftTailLen > 0 ? 16 : 18);
  elements.push(
    <text key="5p" x={fivePrimeX} y={stemBottomY + 1} textAnchor="middle" dominantBaseline="central" fontSize={13} fontFamily="sans-serif" fontWeight="bold" fill="#818cf8">
      5&apos;
    </text>
  );
  const threePrimeX = pos[L - 1]!.x + (rightTailLen > 0 ? 16 : 18);
  elements.push(
    <text key="3p" x={threePrimeX} y={stemBottomY + 1} textAnchor="middle" dominantBaseline="central" fontSize={13} fontFamily="sans-serif" fontWeight="bold" fill="#fb923c">
      3&apos;
    </text>
  );

  // ── Bounding box from all placed points ────────────
  let minX = fivePrimeX,
    maxX = threePrimeX,
    minY = Infinity,
    maxY = stemBottomY;
  for (let i = 0; i < L; i++) {
    const p = pos[i];
    if (!p) continue;
    minX = Math.min(minX, p.x - baseR);
    maxX = Math.max(maxX, p.x + baseR);
    minY = Math.min(minY, p.y - baseR);
    maxY = Math.max(maxY, p.y + baseR);
  }
  const pad = 8;
  minX -= pad;
  maxX += pad;
  minY -= pad;
  maxY += pad;

  return (
    <svg
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      width="100%"
      style={{ maxHeight: '220px' }}
      preserveAspectRatio="xMidYMid meet"
      className="cursor-zoom-in"
      role="button"
      aria-label="Open structure in a new tab"
      onClick={(e) => openSvgInNewTab(e.currentTarget, 'Hairpin structure')}
    >
      <title>Click to open in a new tab</title>
      {elements}
    </svg>
  );
}
