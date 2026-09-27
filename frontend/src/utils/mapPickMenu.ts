import type { SequenceData } from '../api/sequence';
import type { MenuEntry } from '../components/SequenceContextMenu';
import { reverseComplement } from './dna';
import { genomicToSpliced, selectionStrand, type Selection, type Selections } from './regionMapping';
import type { MapPick } from './mapSelection';

/** Which kinds of primer pick a given map accepts (see `SequenceViewer`'s
 * `pickKinds`). A map with no `onSelect` accepts none. */
export type PickKind = 'wga' | 'general' | 'junction' | 'arms' | 'probe';
export const ALL_PICK_KINDS: readonly PickKind[] = ['wga', 'general', 'junction', 'arms', 'probe'];

/** Inclusive length limits (bp) per action - loose on purpose: they only
 * rule out selections an action can't sensibly handle. */
const LIMITS = {
  primer: [10, 60],
  structure: [5, 100],
  blast: [20, 10_000],
} as const satisfies Record<string, readonly [number, number]>;

function lengthReason(len: number, [min, max]: readonly [number, number]): string | null {
  if (len < min) return `Select at least ${min} bp (${len} selected)`;
  if (len > max) return `Select at most ${max.toLocaleString('en-US')} bp (${len.toLocaleString('en-US')} selected)`;
  return null;
}

/** What an ARMS twin pick needs from the dialog that asks for the mutant
 * allele and the twins' names (`ArmsTwinDialog`). */
export interface ArmsTwinRequest {
  strand: 'F' | 'R';
  start: number;
  end: number;
  /** Gene position of the SNP = the twins' 3'-end base. */
  snpPos: number;
  wtBase: string;
}

export interface PickMenuContext {
  data: SequenceData;
  selections: Selections;
  pick: MapPick;
  kinds: ReadonlySet<PickKind>;
  commit: (key: keyof Selections, sel: Selection) => void;
  clear: (key: keyof Selections) => void;
  openBlast: (seq: string) => void;
  openStructures: (seq: string) => void;
  openArmsTwins: (req: ArmsTwinRequest) => void;
}

/** 1-based position from the gene start (negative upstream, no 0) of a
 * region-local index - same convention as the hover tooltip. */
export function genePosLabel(data: SequenceData, region: 'up' | 'gene' | 'down', pos: number): string {
  const local = region === 'up' ? pos - data.upstream_len : region === 'down' ? data.gene_len + pos : pos;
  return (local >= 0 ? local + 1 : local).toLocaleString('en-US');
}

/** Spliced positions where one exon ends and the next begins. */
function junctionPositions(data: SequenceData): number[] {
  const fromData = (data.junctions || []).map((j) => j.pos).filter((p) => Number.isFinite(p));
  if (fromData.length) return fromData;
  const exons = (data.annotations || []).filter((a) => a.type === 'exon').sort((a, b) => a.start - b.start);
  const out: number[] = [];
  let acc = 0;
  for (const ex of exons.slice(0, -1)) {
    acc += ex.end - ex.start;
    out.push(acc);
  }
  return out;
}

/** A junction primer's footprint on the spliced transcript, or why the
 * pick can't be one: it must lie only on exon bases (no intron at all)
 * and cross at least one exon-exon junction. */
export function junctionFromPick(data: SequenceData, pick: MapPick): { start: number; end: number; seq: string } | { reason: string } {
  let start: number;
  let end: number;
  if (pick.kind === 'contiguous' && pick.region === 'spliced') {
    start = pick.start;
    end = pick.end;
  } else if (pick.kind === 'contiguous' && pick.region !== 'gene') {
    return { reason: 'Junction primers lie within exons, not in a flank' };
  } else {
    const pieces = pick.kind === 'gapped' ? pick.pieces : [{ start: pick.start, end: pick.end }];
    const mapped: { start: number; end: number }[] = [];
    for (const piece of pieces) {
      const spans = genomicToSpliced({ region: 'gene', start: piece.start, end: piece.end, primerSeq: '', bindingSeq: '', source: 'manual' }, data);
      const len = spans.reduce((n, r) => n + (r.end - r.start), 0);
      if (len !== piece.end - piece.start) return { reason: 'Contains intron bases - a junction primer must lie on exons only' };
      mapped.push(...spans);
    }
    if (mapped.length === 0) return { reason: 'No exon structure available for this sequence' };
    for (let i = 1; i < mapped.length; i++) {
      if (mapped[i].start !== mapped[i - 1].end) return { reason: 'Skips exon bases - select directly across one collapsed intron' };
    }
    start = mapped[0].start;
    end = mapped[mapped.length - 1].end;
  }
  if (!junctionPositions(data).some((p) => start < p && p < end)) {
    return { reason: 'Does not cross an exon-exon junction' };
  }
  return { start, end, seq: (data.spliced_exons_seq || '').substring(start, end).toUpperCase() };
}

function rawSeq(data: SequenceData, region: 'up' | 'gene' | 'down' | 'spliced'): string {
  if (region === 'up') return data.upstream_seq || '';
  if (region === 'down') return data.downstream_seq || '';
  if (region === 'spliced') return data.spliced_exons_seq || '';
  return data.gene_seq || '';
}

/** The ARMS mutant twin for a wild-type twin: identical but for its 3'
 * base, which carries `arms.mutBase` (sense strand) instead of the
 * template base - the last primer base for a forward twin, the first
 * template base (reverse-complemented) for a reverse one. */
export function armsMutantTwin(wt: Selection, name: string | undefined): Selection {
  const arms = wt.arms!;
  const slice = wt.bindingSeq;
  const strand = selectionStrand(wt);
  const primerSeq = strand === 'F' ? slice.slice(0, -1) + arms.mutBase : reverseComplement(arms.mutBase + slice.slice(1));
  return { ...wt, primerSeq, name, analysis: undefined };
}

/** Creates (or replaces) the ARMS allele-specific twins from a confirmed
 * dialog. A common primer reading the same way as the new twins can't be
 * part of the same set (the layout is 2F+1R or 1F+2R), so it's cleared. */
export function createArmsTwins(ctx: Pick<PickMenuContext, 'data' | 'selections' | 'commit' | 'clear'>, req: ArmsTwinRequest, mutBase: string, wtName: string, mutName: string) {
  const slice = (ctx.data.gene_seq || '').substring(req.start, req.end).toUpperCase();
  const wt: Selection = {
    region: 'gene',
    start: req.start,
    end: req.end,
    primerSeq: req.strand === 'F' ? slice : reverseComplement(slice),
    bindingSeq: slice,
    source: 'manual',
    strand: req.strand,
    name: wtName,
    arms: { snpPos: req.snpPos, wtBase: req.wtBase, mutBase },
  };
  const common = ctx.selections.armsCommon;
  if (common && selectionStrand(common) === req.strand) ctx.clear('armsCommon');
  ctx.commit('armsRefPrimer', wt);
  ctx.commit('armsAltPrimer', armsMutantTwin(wt, mutName));
}

/** Heading + entries for the right-click menu over `ctx.pick`. */
export function buildPickMenu(ctx: PickMenuContext): { heading: string; entries: MenuEntry[] } {
  const { data, selections, pick, kinds } = ctx;
  const contiguous = pick.kind === 'contiguous' ? pick : null;
  const junction = junctionFromPick(data, pick);
  const junctionOk = 'seq' in junction;

  // The sequence BLAST/structures act on: the selected bases, or for a
  // selection across a collapsed intron, the joined exon bases.
  const seq = contiguous ? rawSeq(data, contiguous.region).substring(contiguous.start, contiguous.end).toUpperCase() : junctionOk ? junction.seq : null;
  const len = seq?.length ?? 0;

  let heading: string;
  if (contiguous?.region === 'spliced') heading = `${len} bp · transcript ${(contiguous.start + 1).toLocaleString('en-US')}–${contiguous.end.toLocaleString('en-US')}`;
  else if (contiguous) heading = `${len} bp · ${genePosLabel(data, contiguous.region, contiguous.start)}–${genePosLabel(data, contiguous.region, contiguous.end - 1)}`;
  else {
    const p = (pick as { pieces: { start: number; end: number }[] }).pieces;
    heading = `${junctionOk ? `${len} bp` : 'Across a collapsed intron'} · ${genePosLabel(data, 'gene', p[0].start)}–${genePosLabel(data, 'gene', p[p.length - 1].end - 1)}`;
  }

  const inFlank = contiguous?.region === 'up' || contiguous?.region === 'down';
  const inGene = contiguous?.region === 'gene';
  const notHere = 'Not available in this view';
  const primerLen = contiguous ? lengthReason(len, LIMITS.primer) : null;
  const replaces = (key: keyof Selections) => {
    const s = selections[key];
    return s ? `replaces ${s.name ?? 'the current one'}` : undefined;
  };

  function primerSubmenu(strand: 'F' | 'R'): MenuEntry[] {
    const fwd = strand === 'F';
    const make = (region: Selection['region'], start: number, end: number, slice: string, name: string): Selection => ({
      region,
      start,
      end,
      primerSeq: fwd ? slice : reverseComplement(slice),
      bindingSeq: slice,
      source: 'manual',
      strand,
      name,
    });

    const wgaKey = fwd ? 'wgaForward' : 'wgaReverse';
    const genKey = fwd ? 'geneForward' : 'geneReverse';
    const juncKey = fwd ? 'juncLeft' : 'juncRight';
    const twins = selections.armsRefPrimer;
    const common = selections.armsCommon;

    return [
      {
        shortcut: 'W',
        label: 'WGA (flank)',
        disabledReason: !kinds.has('wga') ? notHere : !inFlank ? 'Select in the upstream/downstream flank' : primerLen,
        hint: replaces(wgaKey),
        onRun: () => contiguous && ctx.commit(wgaKey, make(contiguous.region, contiguous.start, contiguous.end, seq!, fwd ? 'WGA-F' : 'WGA-R')),
      },
      {
        shortcut: 'G',
        label: 'General',
        disabledReason: !kinds.has('general') ? notHere : !inGene ? (inFlank ? 'In a flank, use WGA' : 'Select within the gene') : primerLen,
        hint: replaces(genKey),
        onRun: () => contiguous && ctx.commit(genKey, make('gene', contiguous.start, contiguous.end, seq!, fwd ? 'F' : 'R')),
      },
      {
        shortcut: 'J',
        label: 'Junction (exon-exon)',
        disabledReason: !kinds.has('junction') ? notHere : !junctionOk ? junction.reason : lengthReason(len, LIMITS.primer),
        hint: replaces(juncKey),
        onRun: () => junctionOk && ctx.commit(juncKey, make('spliced', junction.start, junction.end, junction.seq, fwd ? 'J-F' : 'J-R')),
      },
      {
        shortcut: 'T',
        label: 'ARMS allele-specific twins',
        disabledReason: !kinds.has('arms') ? notHere : !inGene ? 'Select within the gene' : primerLen,
        hint: [twins && `replaces ${twins.name ?? 'the twins'}`, common && selectionStrand(common) === strand && `clears the ${fwd ? 'forward' : 'reverse'} common primer`].filter(Boolean).join(' · ') || `3' end on the ${fwd ? 'last' : 'first'} selected base`,
        onRun: () =>
          contiguous &&
          ctx.openArmsTwins({
            strand,
            start: contiguous.start,
            end: contiguous.end,
            snpPos: fwd ? contiguous.end - 1 : contiguous.start,
            wtBase: seq![fwd ? seq!.length - 1 : 0],
          }),
      },
      {
        shortcut: 'C',
        label: 'ARMS common primer',
        disabledReason: !kinds.has('arms') ? notHere : !inGene ? 'Select within the gene' : primerLen,
        hint: [common && `replaces ${common.name ?? 'the common primer'}`, twins && selectionStrand(twins) === strand && `clears the ${fwd ? 'forward' : 'reverse'} twins`].filter(Boolean).join(' · ') || undefined,
        onRun: () => {
          if (!contiguous) return;
          if (twins && selectionStrand(twins) === strand) {
            ctx.clear('armsRefPrimer');
            ctx.clear('armsAltPrimer');
          }
          ctx.commit('armsCommon', make('gene', contiguous.start, contiguous.end, seq!, 'C'));
        },
      },
    ];
  }

  const anyPrimer = kinds.size > 0;
  return {
    heading,
    entries: [
      { shortcut: 'F', label: 'Select as forward primer', disabledReason: anyPrimer ? null : 'Primer picks are not available in this view', submenu: primerSubmenu('F') },
      { shortcut: 'R', label: 'Select as reverse primer', disabledReason: anyPrimer ? null : 'Primer picks are not available in this view', submenu: primerSubmenu('R') },
      {
        shortcut: 'P',
        label: 'Select as probe',
        disabledReason: !kinds.has('probe') ? 'Probe picks are not available in this view' : !inGene ? 'A probe must lie within the gene' : primerLen,
        hint: replaces('geneProbe'),
        onRun: () => contiguous && ctx.commit('geneProbe', { region: 'gene', start: contiguous.start, end: contiguous.end, primerSeq: seq!, bindingSeq: seq!, source: 'manual', strand: 'F', name: 'Probe' }),
      },
      { shortcut: 'B', label: 'BLAST', disabledReason: seq ? lengthReason(len, LIMITS.blast) : 'Select one continuous stretch (or exactly across a collapsed intron)', onRun: () => seq && ctx.openBlast(seq) },
      { shortcut: 'S', label: 'Secondary structures', disabledReason: seq ? lengthReason(len, LIMITS.structure) : 'Select one continuous stretch (or exactly across a collapsed intron)', onRun: () => seq && ctx.openStructures(seq) },
    ],
  };
}
