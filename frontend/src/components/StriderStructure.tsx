/**
 * A secondary structure drawn the way Strider draws it (`strider.viz.
 * structure2d.draw_structure`, as Oligool renders its structure figures):
 * a radial/loop-tree fold, grey backbone, light base-pair rungs, bases as
 * nucleotide-coloured balls with white letters, per-strand position numbers
 * with leader ticks, and strand names on a dimer. Ported to run in the
 * browser (layout: `utils/striderLayout.ts`), so it needs no Python backend.
 *
 * Light and dark mode follow Oligool's Strider theming: the base, backbone
 * and rung colours are mid-tones that read on both backgrounds; only the
 * label text flips. Anything that can't be drawn (length mismatch, no base
 * pairs, an unexpected error) shows `fallback` - the older diagrams.
 */
import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { openSvgInNewTab } from '../utils/openSvgTab';
import { layoutStructure, parsePairs, type Pair, type Pt } from '../utils/striderLayout';

interface Props {
  /** One strand, or both strands of a dimer concatenated (no separator). */
  sequence: string;
  /** Dot-bracket over `sequence`. */
  structure: string;
  /** Where the second strand starts, for a dimer. */
  nick?: number;
  /** Strand names shown on a dimer (default Strider's "S1"/"S2"). */
  strandNames?: string[];
  /** Shown when the structure can't be drawn. */
  fallback: ReactNode;
  /** Name of the tab the figure opens in when clicked. */
  title?: string;
}

// Strider's palette (`strider.viz.style`).
const NT_COLORS: Record<string, string> = { A: '#F2A65A', T: '#6FA8DC', U: '#6FA8DC', C: '#89C997', G: '#E8786F' };
const BACKBONE = '#8c8c8c';
const RUNG = '#cccccc';
const ACCENT = '#B279A2';
const LEADER = '#9aa0a6';
const BALL_EDGE = '#333333';
// Label text - Strider's own for light, Oligool's dark-figure override for dark.
const THEME = {
  light: { name: '#222222', number: '#555555' },
  dark: { name: '#e4e4e7', number: '#a1a1aa' },
};

const RADIUS = 0.42;
/** Data-unit → SVG-unit scale (only sets the viewBox's number range). */
const S = 24;

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const isDark = () => document.documentElement.classList.contains('dark');

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const norm = (a: Pt) => Math.hypot(a[0], a[1]);

interface Label {
  anchor: Pt;
  pos: Pt;
  half: Pt;
  text: string;
  kind: 'name' | 'number';
}

/** One bold name per strand beside its own backbone (`_label_specs`). */
function nameLabels(xy: Pt[], strandLens: number[], names: (string | null)[], rungs: Pair[]): Label[] {
  const centroid = centroidOf(xy);
  const partner = new Map<number, number>();
  for (const [a, b] of rungs) {
    partner.set(a, b);
    partner.set(b, a);
  }
  const out: Label[] = [];
  let off = 0;
  strandLens.forEach((L, sid) => {
    const name = names[sid];
    if (name && L > 0) {
      let local = Math.max(1, Math.min(L, Math.floor(L / 2)));
      if (L > 6 && [0, 1, 2, 9].includes(local % 10)) local = Math.min(L - 2, local + 3);
      const gi = off + local - 1;
      let d = partner.has(gi) ? sub(xy[gi], xy[partner.get(gi)!]) : sub(xy[gi], centroid);
      const n = norm(d);
      d = n > 1e-6 ? [d[0] / n, d[1] / n] : [1, 0];
      out.push({ anchor: xy[gi], pos: [xy[gi][0] + (RADIUS + 0.7) * d[0], xy[gi][1] + (RADIUS + 0.7) * d[1]], half: [(0.26 * name.length) / 2 + 0.16, 0.3], text: name, kind: 'name' });
    }
    off += L;
  });
  return out;
}

/** Per-strand position numbers - first, last and every 10th - with the
 * leader direction from an angular openness search (`_number_specs`). */
function numberLabels(xy: Pt[], rungs: Pair[], strandLens: number[], step = 10): Label[] {
  if (!xy.length) return [];
  const centroid = centroidOf(xy);
  const partner = new Map<number, number>();
  for (const [a, b] of rungs) {
    partner.set(a, b);
    partner.set(b, a);
  }
  const targets = new Map<number, number>();
  const boundsOf = new Map<number, [number, number]>();
  let off = 0;
  for (const L of strandLens) {
    if (L <= 0) continue;
    const marks = new Set([1, L]);
    for (let m = step; m <= L; m += step) if (m > 2 && m < L - 1) marks.add(m);
    for (const t of marks) {
      targets.set(off + t - 1, t);
      boundsOf.set(off + t - 1, [off, off + L - 1]);
    }
    off += L;
  }
  const nearestOther = (c: Pt, exclude: number) => {
    let best = Infinity;
    xy.forEach((p, j) => {
      if (j !== exclude) best = Math.min(best, Math.hypot(p[0] - c[0], p[1] - c[1]));
    });
    return best;
  };
  const naturalDir = (i: number): Pt => {
    let d: Pt;
    if (partner.has(i)) d = sub(xy[i], xy[partner.get(i)!]);
    else {
      const [lo, hi] = boundsOf.get(i) ?? [0, xy.length - 1];
      const t = sub(xy[Math.min(hi, i + 1)], xy[Math.max(lo, i - 1)]);
      d = norm(t) > 1e-6 ? [-t[1], t[0]] : sub(xy[i], centroid);
    }
    const n = norm(d);
    return n > 1e-6 ? [d[0] / n, d[1] / n] : [0, -1];
  };
  const probes = [RADIUS + 0.6, RADIUS + 1.0, RADIUS + 1.6];
  const out: Label[] = [];
  for (const i of [...targets.keys()].sort((a, b) => a - b)) {
    const nat = naturalDir(i);
    let d = nat;
    let best = -1e18;
    for (let k = 0; k < 48; k++) {
      const ang = (2 * Math.PI * k) / 48;
      const cand: Pt = [Math.cos(ang), Math.sin(ang)];
      const clear = Math.min(...probes.map((pr) => nearestOther([xy[i][0] + pr * cand[0], xy[i][1] + pr * cand[1]], i)));
      const score = clear + 0.5 * (cand[0] * nat[0] + cand[1] * nat[1]);
      if (score > best) {
        best = score;
        d = cand;
      }
    }
    const text = String(targets.get(i));
    out.push({ anchor: xy[i], pos: [xy[i][0] + (RADIUS + 0.95) * d[0], xy[i][1] + (RADIUS + 0.95) * d[1]], half: [(0.11 * text.length) / 2 + 0.13, 0.22], text, kind: 'number' });
  }
  return out;
}

/** Pushes labels apart from each other and off the bases (`_place_all_labels`). */
function placeLabels(labels: Label[], coords: Pt[]) {
  const pos = labels.map((l): Pt => [...l.pos]);
  for (let it = 0; it < 120; it++) {
    let moved = false;
    for (let a = 0; a < pos.length; a++) {
      for (let b = a + 1; b < pos.length; b++) {
        const dx = pos[a][0] - pos[b][0];
        const dy = pos[a][1] - pos[b][1];
        const ox = labels[a].half[0] + labels[b].half[0] - Math.abs(dx);
        const oy = labels[a].half[1] + labels[b].half[1] - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox <= oy) {
            const s = (ox / 2 + 0.03) * (dx >= 0 ? 1 : -1);
            pos[a][0] += s;
            pos[b][0] -= s;
          } else {
            const s = (oy / 2 + 0.03) * (dy >= 0 ? 1 : -1);
            pos[a][1] += s;
            pos[b][1] -= s;
          }
          moved = true;
        }
      }
    }
    for (let a = 0; a < pos.length; a++) {
      let jm = 0;
      let dm = Infinity;
      coords.forEach((c, j) => {
        const d = Math.hypot(c[0] - pos[a][0], c[1] - pos[a][1]);
        if (d < dm) {
          dm = d;
          jm = j;
        }
      });
      const clear = RADIUS + Math.max(...labels[a].half) + 0.05;
      if (dm < clear) {
        const push = sub(pos[a], coords[jm]);
        const pn = norm(push) || 1;
        pos[a][0] += (push[0] / pn) * (clear - dm);
        pos[a][1] += (push[1] / pn) * (clear - dm);
        moved = true;
      }
    }
    if (!moved) break;
  }
  labels.forEach((l, i) => {
    l.pos = pos[i];
  });
}

function centroidOf(xy: Pt[]): Pt {
  const n = xy.length || 1;
  return [xy.reduce((s, p) => s + p[0], 0) / n, xy.reduce((s, p) => s + p[1], 0) / n];
}

interface Figure {
  seq: string;
  coords: Pt[];
  backbone: Pair[];
  rungs: Pair[];
  crossing: Pair[];
  labels: Label[];
  box: { x: number; y: number; w: number; h: number };
}

function buildFigure(sequence: string, structure: string, nick: number | undefined, strandNames: string[] | undefined): Figure | null {
  const seq = sequence.toUpperCase();
  const db = structure.replace(/[&+]/g, '');
  if (!seq || seq.length !== db.length || parsePairs(db).length === 0) return null;
  const nicks = nick !== undefined && nick > 0 && nick < seq.length ? [nick] : [];
  const layout = layoutStructure(seq.length, db, nicks);
  const xy = layout.coords;
  if (xy.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;

  const names = layout.strandLens.length > 1 ? layout.strandLens.map((_, k) => strandNames?.[k] ?? `S${k + 1}`) : [null];
  const labels = [...nameLabels(xy, layout.strandLens, names, [...layout.rungs, ...layout.crossing]), ...numberLabels(xy, layout.rungs, layout.strandLens)];
  placeLabels(labels, xy);

  const pts = [...xy, ...labels.map((l) => l.pos)];
  const pad = RADIUS + 0.8;
  const minX = Math.min(...pts.map((p) => p[0])) - pad;
  const maxX = Math.max(...pts.map((p) => p[0])) + pad;
  const minY = Math.min(...pts.map((p) => p[1])) - pad;
  const maxY = Math.max(...pts.map((p) => p[1])) + pad;
  // SVG y grows downward: flip.
  return { seq, coords: xy, backbone: layout.backbone, rungs: layout.rungs, crossing: layout.crossing, labels, box: { x: minX * S, y: -maxY * S, w: (maxX - minX) * S, h: (maxY - minY) * S } };
}

export default function StriderStructure({ sequence, structure, nick, strandNames, fallback, title = 'Secondary structure' }: Props) {
  const dark = useSyncExternalStore(subscribeTheme, isDark, () => false);
  const figure = useMemo(() => {
    try {
      return buildFigure(sequence, structure, nick, strandNames);
    } catch {
      return null;
    }
  }, [sequence, structure, nick, strandNames]);

  if (!figure) return <>{fallback}</>;
  const theme = dark ? THEME.dark : THEME.light;
  const X = (p: Pt) => p[0] * S;
  const Y = (p: Pt) => -p[1] * S;
  const { coords: xy } = figure;
  const line = (i: number, j: number) => ({ x1: X(xy[i]), y1: Y(xy[i]), x2: X(xy[j]), y2: Y(xy[j]) });

  return (
    <svg
      viewBox={`${figure.box.x} ${figure.box.y} ${figure.box.w} ${figure.box.h}`}
      width="100%"
      style={{ maxHeight: '280px' }}
      preserveAspectRatio="xMidYMid meet"
      className="cursor-zoom-in"
      role="button"
      aria-label="Open structure in a new tab"
      onClick={(e) => openSvgInNewTab(e.currentTarget, title)}
      fontFamily="'DejaVu Sans', Arial, Helvetica, sans-serif"
    >
      <title>Click to open in a new tab</title>
      {figure.backbone.map(([i, j]) => (
        <line key={`b${i}`} {...line(i, j)} stroke={BACKBONE} strokeWidth={0.075 * S} strokeLinecap="round" />
      ))}
      {figure.rungs.map(([i, j]) => (
        <line key={`r${i}`} {...line(i, j)} stroke={RUNG} strokeWidth={0.055 * S} />
      ))}
      {figure.crossing.map(([i, j]) => (
        <line key={`c${i}`} {...line(i, j)} stroke={ACCENT} strokeWidth={0.055 * S} strokeDasharray={`${0.15 * S} ${0.1 * S}`} opacity={0.8} />
      ))}
      {figure.labels.map((l, k) => {
        if (l.kind !== 'number') return null;
        // Leader tick from the ball's edge toward the number, if there's room.
        const seg = sub(l.pos, l.anchor);
        const sn = norm(seg) || 1;
        const u: Pt = [seg[0] / sn, seg[1] / sn];
        const start: Pt = [l.anchor[0] + RADIUS * u[0], l.anchor[1] + RADIUS * u[1]];
        const reach = Math.max(...l.half) + 0.1;
        const elbow: Pt = [l.pos[0] - reach * u[0], l.pos[1] - reach * u[1]];
        if ((elbow[0] - start[0]) * u[0] + (elbow[1] - start[1]) * u[1] <= 0) return null;
        return <line key={`l${k}`} x1={X(start)} y1={Y(start)} x2={X(elbow)} y2={Y(elbow)} stroke={LEADER} strokeWidth={0.04 * S} />;
      })}
      {xy.map((p, i) => (
        <g key={`n${i}`}>
          <circle cx={X(p)} cy={Y(p)} r={RADIUS * S} fill={NT_COLORS[figure.seq[i]] ?? 'gray'} stroke={BALL_EDGE} strokeWidth={0.025 * S} />
          <text x={X(p)} y={Y(p)} textAnchor="middle" dominantBaseline="central" fontSize={0.66 * S} fontWeight="bold" fill="#ffffff">
            {figure.seq[i]}
          </text>
        </g>
      ))}
      {figure.labels.map((l, k) => (
        <text
          key={`t${k}`}
          x={X(l.pos)}
          y={Y(l.pos)}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={(l.kind === 'name' ? 0.4 : 0.3) * S}
          fontWeight={l.kind === 'name' ? 'bold' : 'normal'}
          fill={l.kind === 'name' ? theme.name : theme.number}
        >
          {l.text}
        </text>
      ))}
    </svg>
  );
}
