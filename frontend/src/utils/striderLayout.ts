/**
 * 2D layout for nucleic-acid secondary structures - a TypeScript port of
 * Strider's `strider.viz.geometry` + `strider.viz.layout` (the renderer
 * Oligool draws its structure figures with), so Primerool draws the same
 * folds without Strider's Python/matplotlib stack.
 *
 * `layoutStructure` resolves pairs and strand breaks and picks Strider's
 * `method="auto"` layout: the compact RNAplot-style radial layout, falling
 * back to the space-aware loop-tree layout only when a branched structure
 * would overlap. Coordinates are in Strider's data units (one base spacing
 * = 1), y pointing up. The optional spring relaxation and multi-strand
 * reordering (>2 strands only) are not ported - Primerool draws single
 * strands and two-strand dimers.
 */

export type Pt = [number, number];
export type Pair = [number, number];

export interface Layout2D {
  coords: Pt[];
  /** (i, i+1) backbone segments, strand breaks omitted. */
  backbone: Pair[];
  /** Nested base pairs. */
  rungs: Pair[];
  /** Pseudoknot pairs (drawn as dashed chords). */
  crossing: Pair[];
  /** Strand-break indices (first base of each strand after the first). */
  nicks: number[];
  strandLens: number[];
}

const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const norm = (a: Pt) => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => mul(a, 1 / (norm(a) || 1));
const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Pairs of a dot-bracket string over its concatenated index space -
 * `()`, `[]`, `{}` and `<>` levels, `&`/`+` separators skipped, a
 * mismatched bracket ignored (as `strider.structure.dot_bracket`). */
export function parsePairs(structure: string): Pair[] {
  const open: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
  const close: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };
  const stacks: Record<string, number[]> = { '(': [], '[': [], '{': [], '<': [] };
  const pairs: Pair[] = [];
  const clean = structure.replace(/[&+]/g, '');
  for (let idx = 0; idx < clean.length; idx++) {
    const ch = clean[idx];
    if (ch in open) stacks[ch].push(idx);
    else if (ch in close) {
      const j = stacks[close[ch]].pop();
      if (j !== undefined) pairs.push([j, idx]);
    }
  }
  return pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function crosses([a, b]: Pair, [c, d]: Pair): boolean {
  return (a < c && c < b && b < d) || (c < a && a < d && d < b);
}

/** Splits pairs into a maximal nested set and the crossing leftovers. */
export function classifyPairs(pairs: Pair[]): { nested: Pair[]; crossing: Pair[] } {
  const nested: Pair[] = [];
  const crossing: Pair[] = [];
  const sorted = pairs.map(([i, j]): Pair => [Math.min(i, j), Math.max(i, j)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const p of sorted) {
    if (nested.some((q) => crosses(p, q))) crossing.push(p);
    else nested.push(p);
  }
  return { nested, crossing };
}

function partnerArray(pairs: Pair[], n: number): number[] {
  const partner = new Array<number>(n).fill(-1);
  for (const [i, j] of pairs) {
    partner[i] = j;
    partner[j] = i;
  }
  return partner;
}

function stemLength(partner: number[], c: number, d: number): number {
  let length = 0;
  while (c + length < d - length && partner[c + length] === d - length) length++;
  return length;
}

interface TreeNode {
  kind: 'external' | 'helix' | 'loop';
  children: TreeNode[];
}

function buildStructureTree(pairs: Pair[], n: number): TreeNode {
  const partner = partnerArray(pairs, n);
  function buildLoop(lo: number, hi: number, kind: 'external' | 'loop'): TreeNode {
    const node: TreeNode = { kind, children: [] };
    let i = lo;
    while (i < hi) {
      const j = partner[i];
      if (j === -1 || j < i) {
        i++;
      } else {
        const length = stemLength(partner, i, j);
        const helix: TreeNode = { kind: 'helix', children: [buildLoop(i + length, j - length + 1, 'loop')] };
        node.children.push(helix);
        i = j + 1;
      }
    }
    return node;
  }
  return buildLoop(0, n, 'external');
}

/** True if some loop (incl. the exterior) has >= 2 child helices. */
function isBranched(nested: Pair[], n: number): boolean {
  const scan = (node: TreeNode): boolean => {
    if (node.kind !== 'helix' && node.children.filter((c) => c.kind === 'helix').length >= 2) return true;
    return node.children.some(scan);
  };
  return scan(buildStructureTree(nested, n));
}

/** True as soon as two segments properly cross (shared endpoints excluded). */
function hasSegmentCrossing(coords: Pt[], segments: Pair[]): boolean {
  const side = (a: Pt, b: Pt, c: Pt) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i];
    const p1 = coords[a];
    const p2 = coords[b];
    for (let j = i + 1; j < segments.length; j++) {
      const [c, d] = segments[j];
      if (a === c || a === d || b === c || b === d) continue;
      const p3 = coords[c];
      const p4 = coords[d];
      if (side(p3, p4, p1) > 0 !== side(p3, p4, p2) > 0 && side(p1, p2, p3) > 0 !== side(p1, p2, p4) > 0) return true;
    }
  }
  return false;
}

function minPairDistance(coords: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < coords.length; i++) for (let j = i + 1; j < coords.length; j++) best = Math.min(best, norm(sub(coords[i], coords[j])));
  return best;
}

const angleOf = (v: Pt) => Math.atan2(v[1], v[0]);
const onCircle = (center: Pt, r: number, ang: number): Pt => [center[0] + r * Math.cos(ang), center[1] + r * Math.sin(ang)];

/** RNAplot/NAView-style radial coordinates from a nested pair list. */
function radialLayout(pairs: Pair[], n: number, nicks: number[], spacing = 1, rise = 1): Pt[] {
  const coords: Pt[] = Array.from({ length: n }, (): Pt => [0, 0]);
  if (n === 0) return coords;
  const partner = partnerArray(pairs, n);
  const pd = spacing;

  function placeStem(c: number, d: number, direction: Pt) {
    const u = unit(direction);
    const length = stemLength(partner, c, d);
    for (let t = 1; t < length; t++) {
      coords[c + t] = add(coords[c], mul(u, t * rise));
      coords[d - t] = add(coords[d], mul(u, t * rise));
    }
    placeLoop(c + length - 1, d - length + 1, u);
  }

  function placeLoop(a: number, b: number, inward: Pt) {
    const boundary = [a];
    let i = a + 1;
    while (i < b) {
      const j = partner[i];
      if (j === -1 || j < i) {
        boundary.push(i);
        i++;
      } else {
        boundary.push(i, j);
        i = j + 1;
      }
    }
    boundary.push(b);
    const k = boundary.length;
    if (k < 3) return;
    const Pa = coords[a];
    const Pb = coords[b];
    const mid = mul(add(Pa, Pb), 0.5);
    const dAb = norm(sub(Pa, Pb)) || pd;
    const u = unit(inward);
    const r = dAb / 2 / Math.sin(Math.PI / k);
    const h = Math.sqrt(Math.max(r * r - (dAb / 2) ** 2, 0));
    const center = add(mid, mul(u, h));
    const angA = angleOf(sub(Pa, center));
    const angB = angleOf(sub(Pb, center));
    const ccw = mod(angB - angA, 2 * Math.PI);
    const step = ccw >= Math.PI ? ccw / (k - 1) : -((2 * Math.PI - ccw) / (k - 1));
    boundary.forEach((base, s) => {
      coords[base] = onCircle(center, r, angA + s * step);
    });
    for (const base of boundary) {
      const j = partner[base];
      if (j !== -1 && j > base && base !== a) placeStem(base, j, sub(mul(add(coords[base], coords[j]), 0.5), center));
    }
  }

  const nickSet = new Set(nicks);
  const spansNick = (c: number, d: number) => [...nickSet].some((k) => c < k && k <= d);

  type Item = { kind: 'base'; i: number } | { kind: 'helix'; i: number; j: number };
  const items: Item[] = [];
  for (let i = 0; i < n; ) {
    const j = partner[i];
    if (j === -1 || j < i) {
      items.push({ kind: 'base', i });
      i++;
    } else {
      items.push({ kind: 'helix', i, j });
      i = j + 1;
    }
  }
  const helices = items.filter((it): it is Extract<Item, { kind: 'helix' }> => it.kind === 'helix');
  const hasBases = items.some((it) => it.kind === 'base');

  if (helices.length === 0) {
    for (let idx = 0; idx < n; idx++) coords[idx] = [idx * spacing, 0];
    return coords;
  }

  const isLinearDuplex = () => {
    if (hasBases) return false;
    for (let t = 0; t + 1 < helices.length; t++) {
      const a = helices[t];
      const b = helices[t + 1];
      if (!(b.i === a.j + 1 && !nickSet.has(b.i) && spansNick(a.i, a.j) && spansNick(b.i, b.j))) return false;
    }
    return true;
  };

  if (isLinearDuplex()) {
    let prev: { axial: Pt; closePt: Pt; rung: Pt } | null = null;
    for (const { i: ci, j: cj } of helices) {
      let direction: Pt;
      if (prev) {
        direction = mul(prev.axial, -1);
        coords[ci] = add(prev.closePt, mul(direction, rise));
        coords[cj] = add(coords[ci], prev.rung);
      } else {
        direction = [0, 1];
        coords[ci] = [0, 0];
        coords[cj] = [pd, 0];
      }
      placeStem(ci, cj, direction);
      prev = { axial: direction, closePt: [...coords[cj]] as Pt, rung: sub(coords[ci], coords[cj]) };
    }
    return coords;
  }

  // Radial exterior loop: every exterior element around one circle.
  const circlePts: number[] = [];
  const helixSlots: Pair[] = [];
  for (const it of items) {
    if (it.kind === 'base') circlePts.push(it.i);
    else {
      circlePts.push(it.i);
      helixSlots.push([it.i, it.j]);
      circlePts.push(it.j);
    }
  }
  const k = circlePts.length + 1; // one extra slot for the open 5'->3' gap
  const r = pd / (2 * Math.sin(Math.PI / k));
  const baseAng = -Math.PI / 2;
  circlePts.forEach((base, slot) => {
    coords[base] = onCircle([0, 0], r, baseAng + ((slot + 1) * 2 * Math.PI) / k);
  });
  for (const [ci, cj] of helixSlots) placeStem(ci, cj, unit(mul(add(coords[ci], coords[cj]), 0.5)));
  return coords;
}

const TREE_BLEND_LEVELS = [0.0, 0.15, 0.3, 0.45, 0.6, 0.8, 1.0];

/** Space-aware loop-tree layout (RNApuzzler-style), for branched folds
 * whose radial layout would overlap. */
function treeLayout(pairs: Pair[], n: number, nicks: number[], spacing = 1, rise = 1, safety = 1.5): Pt[] {
  if (n === 0) return [];
  const partner = partnerArray(pairs, n);
  const pd = spacing;

  type Item = { kind: 'base'; i: number } | { kind: 'stem'; c: number; d: number };
  function boundary(a: number, b: number): Item[] {
    const items: Item[] = [];
    for (let i = a + 1; i < b; ) {
      const j = partner[i];
      if (j === -1 || j < i) {
        items.push({ kind: 'base', i });
        i++;
      } else {
        items.push({ kind: 'stem', c: i, d: j });
        i = j + 1;
      }
    }
    return items;
  }

  const baseAngle = (r: number) => 2 * Math.asin(Math.min(1, pd / 2 / r));

  type Meta = { kind: 'end' | 'base' | 'open' | 'close'; point: number; stem: number };
  function metasOf(items: Item[], ends: number): Meta[] {
    const m: Meta[] = ends === 2 ? [{ kind: 'end', point: -1, stem: -1 }] : [];
    for (const it of items) {
      if (it.kind === 'base') m.push({ kind: 'base', point: it.i, stem: it.i });
      else {
        m.push({ kind: 'open', point: it.c, stem: it.c });
        m.push({ kind: 'close', point: it.d, stem: it.c });
      }
    }
    if (ends === 2) m.push({ kind: 'end', point: -1, stem: -1 });
    return m;
  }

  function layout(blend: number): Pt[] {
    const coords: Pt[] = Array.from({ length: n }, (): Pt => [0, 0]);
    const R = new Map<number, number>();
    const W = new Map<number, number>();
    const sl = new Map<number, number>();
    const rOf = new Map<number, number>();
    const reachOf = (c: number) => W.get(c)! + blend * (R.get(c)! - W.get(c)!);

    function gapsOf(metas: Meta[], r: number): { gaps: number[]; rigid: boolean[] } {
      const ba = baseAngle(r);
      const gaps: number[] = [];
      const rigid: boolean[] = [];
      for (let s = 0; s + 1 < metas.length; s++) {
        const cur = metas[s];
        const nxt = metas[s + 1];
        const isRigid = cur.kind === 'open' && nxt.kind === 'close' && cur.stem === nxt.stem;
        let g = ba;
        if (!isRigid) {
          if (nxt.kind === 'open') g += safety * Math.atan(reachOf(nxt.stem) / (r + sl.get(nxt.stem)! * rise));
          if (cur.kind === 'close') g += safety * Math.atan(reachOf(cur.stem) / (r + sl.get(cur.stem)! * rise));
        }
        gaps.push(g);
        rigid.push(isRigid);
      }
      return { gaps, rigid };
    }

    const demand = (items: Item[], ends: number, r: number) => gapsOf(metasOf(items, ends), r).gaps.reduce((s, g) => s + g, 0) + baseAngle(r);

    function solveRadius(items: Item[], ends: number): number {
      const nPts = ends + items.reduce((s, it) => s + (it.kind === 'base' ? 1 : 2), 0);
      const r = pd / 2 / Math.sin(Math.PI / Math.max(nPts, 3));
      if (demand(items, ends, r) <= 2 * Math.PI) return r;
      let lo = r;
      let hi = r;
      for (let t = 0; t < 200; t++) {
        hi *= 1.5;
        if (demand(items, ends, hi) <= 2 * Math.PI) break;
      }
      for (let t = 0; t < 60; t++) {
        const mid = 0.5 * (lo + hi);
        if (demand(items, ends, mid) <= 2 * Math.PI) hi = mid;
        else lo = mid;
      }
      return hi;
    }

    function measureStem(c: number, d: number): number {
      const len = stemLength(partner, c, d);
      sl.set(c, len);
      const a2 = c + len - 1;
      const b2 = d - len + 1;
      const items = boundary(a2, b2);
      let childReach = 0;
      let childWidth = 0;
      for (const it of items) {
        if (it.kind === 'stem') {
          const rIn = measureStem(it.c, it.d);
          childReach = Math.max(childReach, sl.get(it.c)! * rise + rIn);
          childWidth = Math.max(childWidth, W.get(it.c)!);
        }
      }
      const rLoop = solveRadius(items, 2);
      rOf.set(a2, rLoop);
      R.set(c, rLoop + childReach);
      W.set(c, Math.max(rLoop, childWidth));
      return R.get(c)!;
    }

    const extItems = boundary(-1, n);
    for (const it of extItems) if (it.kind === 'stem') measureStem(it.c, it.d);

    function placeChildren(items: Item[], ends: number, center: Pt, r: number, ang0: number, direction: number) {
      const metas = metasOf(items, ends);
      const { gaps, rigid } = gapsOf(metas, r);
      const free = rigid.flatMap((rg, i) => (rg ? [] : [i]));
      const slack = 2 * Math.PI - (gaps.reduce((s, g) => s + g, 0) + baseAngle(r));
      if (free.length && slack > 0) for (const i of free) gaps[i] += slack / free.length;
      let cum = 0;
      metas.forEach((m, idx) => {
        if (m.kind !== 'end') coords[m.point] = onCircle(center, r, ang0 + direction * cum);
        if (idx < gaps.length) cum += gaps[idx];
      });
      for (const it of items) if (it.kind === 'stem') placeStem(it.c, it.d, sub(mul(add(coords[it.c], coords[it.d]), 0.5), center));
    }

    function placeStem(c: number, d: number, direction: Pt) {
      const u = unit(direction);
      const len = sl.get(c)!;
      for (let t = 1; t < len; t++) {
        coords[c + t] = add(coords[c], mul(u, t * rise));
        coords[d - t] = add(coords[d], mul(u, t * rise));
      }
      placeLoop(c + len - 1, d - len + 1, u);
    }

    function placeLoop(a: number, b: number, inward: Pt) {
      const items = boundary(a, b);
      if (!items.length) return;
      const r = rOf.get(a)!;
      const Pa = coords[a];
      const Pb = coords[b];
      const mid = mul(add(Pa, Pb), 0.5);
      const u = unit(inward);
      const h = Math.sqrt(Math.max(r * r - (pd / 2) ** 2, 0));
      const center = add(mid, mul(u, h));
      const angA = angleOf(sub(Pa, center));
      const angB = angleOf(sub(Pb, center));
      const ccw = mod(angB - angA, 2 * Math.PI);
      placeChildren(items, 2, center, r, angA, ccw >= Math.PI ? 1 : -1);
    }

    if (!extItems.some((it) => it.kind === 'stem')) {
      for (let idx = 0; idx < n; idx++) coords[idx] = [idx * pd, 0];
      return coords;
    }
    const rExt = solveRadius(extItems, 0);
    placeChildren(extItems, 0, [0, 0], rExt, -Math.PI / 2 + baseAngle(rExt), 1);
    return coords;
  }

  const nickSet = new Set(nicks);
  const acceptSegs: Pair[] = [];
  for (let i = 0; i + 1 < n; i++) if (!nickSet.has(i + 1)) acceptSegs.push([i, i + 1]);
  acceptSegs.push(...pairs);
  let coords: Pt[] = [];
  for (const blend of TREE_BLEND_LEVELS) {
    coords = layout(blend);
    if (!hasSegmentCrossing(coords, acceptSegs) && minPairDistance(coords) > 0.99 * pd) return coords;
  }
  return coords;
}

/** Drawable geometry for `structure` over `n` bases with strand breaks at
 * `nicks` - Strider's `layout_structure(method="auto")`. */
export function layoutStructure(n: number, structure: string, nicks: number[] = []): Layout2D {
  const pairs = parsePairs(structure).filter(([i, j]) => i >= 0 && i < n && j >= 0 && j < n);
  const { nested, crossing } = classifyPairs(pairs);
  const nickSet = new Set(nicks);
  const backbone: Pair[] = [];
  for (let i = 0; i + 1 < n; i++) if (!nickSet.has(i + 1)) backbone.push([i, i + 1]);

  let coords = radialLayout(nested, n, nicks);
  if (isBranched(nested, n) && hasSegmentCrossing(coords, [...backbone, ...nested])) coords = treeLayout(nested, n, nicks);

  const bounds = [0, ...nicks, n];
  const strandLens: number[] = [];
  for (let s = 0; s + 1 < bounds.length; s++) strandLens.push(bounds[s + 1] - bounds[s]);
  return { coords, backbone, rungs: nested, crossing, nicks, strandLens };
}
