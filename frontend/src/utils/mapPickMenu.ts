import type { SequenceData } from '../api/sequence';
import type { MenuEntry } from '../components/SequenceContextMenu';
import { reverseComplement } from './dna';
import { isPlusOriented } from './orientation';
import { genomicToSpliced, selectionStrand, type Selection, type Selections } from './regionMapping';
import type { MapPick } from './mapSelection';

/** Which kinds of primer pick a given map accepts (see `SequenceViewer`'s
 * `pickKinds`). A map with no `onSelect` accepts none. */
export type PickKind = 'wga' | 'general' | 'junction' | 'arms' | 'probe';
export const ALL_PICK_KINDS: readonly PickKind[] = ['wga', 'general', 'junction', 'arms', 'probe'];

/** Inclusive length limits (bp) per action - loose on purpose: they only
 * rule out selections an action can't sensibly handle. */
export const LIMITS = {
  /** Also bounds resizing a primer/probe by dragging its ends in the map. */
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

/** What an allele-detection probe pick needs from the dialog that asks
 * which probe base is the SNP and what its mutant allele is
 * (`AlleleProbeDialog`). */
export interface AlleleProbeRequest {
  start: number;
  end: number;
  /** The selected gene bases, sense strand. */
  seq: string;
  /** A variant the user just located (the "Find in sequence" rsID search),
   * offered as this probe's SNP - `snpPos` may lie outside `[start, end)`;
   * the dialog decides whether to pre-select it or just mention it. */
  snpSuggestion?: RsSnpSuggestion;
}

/** An rsID lookup's SNP in `gene_seq` coordinates, proposed as an allele
 * probe's SNP - the template base (when it is a plain base) and its first
 * variant allele (when the catalog reported one). */
export interface RsSnpSuggestion {
  snpPos: number;
  wtBase: string | null;
  altBase: string | null;
  rsid: string;
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
  openAlleleProbe: (req: AlleleProbeRequest) => void;
  /** The rsID currently located by the map's "Find in sequence" search, if
   * any - proposed as a new allele-probe pair's SNP (never applied to an
   * already-existing pair). */
  rsSuggestion?: RsSnpSuggestion;
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

/** Whether a spliced span has bases on both sides of an exon-exon
 * junction. */
export function crossesJunction(data: SequenceData, start: number, end: number): boolean {
  return junctionPositions(data).some((p) => start < p && p < end);
}

/** A pick's footprint on the spliced transcript when it lies on exon bases
 * only (across collapsed introns allowed), plus whether it crosses an
 * exon-exon junction - or why it isn't exon-only. */
export function junctionFromPick(data: SequenceData, pick: MapPick): { start: number; end: number; seq: string; crosses: boolean } | { reason: string } {
  let start: number;
  let end: number;
  if (pick.kind === 'contiguous' && pick.region === 'spliced') {
    start = pick.start;
    end = pick.end;
  } else if (pick.kind === 'contiguous' && pick.region !== 'gene') {
    return { reason: 'Junction primers lie within the gene, not in a flank' };
  } else {
    const pieces = pick.kind === 'gapped' ? pick.pieces : [{ start: pick.start, end: pick.end }];
    const mapped: { start: number; end: number }[] = [];
    for (const piece of pieces) {
      const spans = genomicToSpliced({ region: 'gene', start: piece.start, end: piece.end, primerSeq: '', bindingSeq: '', source: 'manual' }, data);
      const len = spans.reduce((n, r) => n + (r.end - r.start), 0);
      if (len !== piece.end - piece.start) return { reason: 'Contains intron bases' };
      mapped.push(...spans);
    }
    if (mapped.length === 0) return { reason: 'No exon structure available for this sequence' };
    for (let i = 1; i < mapped.length; i++) {
      if (mapped[i].start !== mapped[i - 1].end) return { reason: 'Skips exon bases - select directly across one collapsed intron' };
    }
    start = mapped[0].start;
    end = mapped[mapped.length - 1].end;
  }
  return { start, end, seq: (data.spliced_exons_seq || '').substring(start, end).toUpperCase(), crosses: crossesJunction(data, start, end) };
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

/** Re-stamps an allele probe's mutant base after its span was rebuilt from
 * bare template (e.g. a drag/resize on a map, which derives `primerSeq` as
 * the plain template slice): the wild-type probe reads as the template,
 * the mutant carries `allele.mutBase` at the SNP, in the selection's own
 * strand sense. No-op for allele-less selections or a SNP left outside the
 * span (a drag can't do that - `mustCover` keeps it inside). */
export function withAlleleBase(sel: Selection): Selection {
  const allele = sel.allele;
  if (!allele) return sel;
  const i = allele.snpPos - sel.start;
  if (i < 0 || i >= sel.bindingSeq.length) return sel;
  const slice = sel.bindingSeq.slice(0, i) + allele.mutBase + sel.bindingSeq.slice(i + 1);
  return { ...sel, primerSeq: selectionStrand(sel) === 'F' ? slice : reverseComplement(slice) };
}

/** The mutant probe for a wild-type allele-detection probe: identical but
 * for the SNP base, which carries `allele.mutBase`. */
export function alleleMutantProbe(wt: Selection, name: string | undefined): Selection {
  const { snpPos, mutBase } = wt.allele!;
  const i = snpPos - wt.start;
  const primerSeq = wt.bindingSeq.slice(0, i) + mutBase + wt.bindingSeq.slice(i + 1);
  return { ...wt, primerSeq, name, analysis: undefined };
}

/** Creates (or replaces) the wild-type/mutant probe pair from a confirmed
 * dialog. */
export function createAlleleProbes(ctx: Pick<PickMenuContext, 'commit'>, req: AlleleProbeRequest, snpPos: number, mutBase: string, wtName: string, mutName: string) {
  const slice = req.seq.toUpperCase();
  const wt: Selection = {
    region: 'gene',
    start: req.start,
    end: req.end,
    primerSeq: slice,
    bindingSeq: slice,
    source: 'manual',
    strand: 'F',
    name: wtName,
    allele: { snpPos, wtBase: slice[snpPos - req.start], mutBase },
  };
  ctx.commit('geneProbe', wt);
  ctx.commit('geneProbeAlt', alleleMutantProbe(wt, mutName));
}

/** Heading + entries for the right-click menu over `ctx.pick`. */
export function buildPickMenu(ctx: PickMenuContext): { heading: string; entries: MenuEntry[] } {
  const { data, selections, pick, kinds } = ctx;
  const contiguous = pick.kind === 'contiguous' ? pick : null;
  // The strand of the map being shown - follows the strand toggle, so the
  // forward/reverse entries name exactly the strand a pick would read on.
  const strandLabel = isPlusOriented(data) ? '+' : '−';
  const junction = junctionFromPick(data, pick);
  const junctionOk = 'seq' in junction;
  // Only an exon-only pick crossing a junction stands in for joined exon
  // bases (BLAST/structures across a collapsed intron).
  const junctionSeq = junctionOk && pick.kind === 'gapped' ? junction.seq : null;

  // The sequence BLAST/structures act on: the selected bases, or for a
  // selection across a collapsed intron, the joined exon bases.
  const seq = contiguous ? rawSeq(data, contiguous.region).substring(contiguous.start, contiguous.end).toUpperCase() : junctionSeq;
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

    /** A junction pair needs one primer crossing an exon-exon junction;
     * once one does, its partner may lie anywhere in the gene - a plain
     * exon (kept on the spliced transcript) or an intron (kept in gene
     * coordinates, since it has no spliced position). */
    function junctionEntry(): MenuEntry {
      const partner = selections[fwd ? 'juncRight' : 'juncLeft'];
      const partnerCrosses = !!partner && partner.region === 'spliced' && crossesJunction(data, partner.start, partner.end);
      const name = fwd ? 'J-F' : 'J-R';
      const base = { shortcut: 'J', label: 'Junction (exon-exon)' };
      if (!kinds.has('junction')) return { ...base, disabledReason: notHere };
      if (junctionOk) {
        const ok = junction.crosses || partnerCrosses;
        return {
          ...base,
          disabledReason: ok ? lengthReason(junction.end - junction.start, LIMITS.primer) : `Does not cross an exon-exon junction - the first junction primer must (its partner may then lie anywhere in the gene)`,
          hint: [replaces(juncKey), !junction.crosses && partnerCrosses && `${partner!.name ?? 'partner'} crosses the junction`].filter(Boolean).join(' · ') || undefined,
          onRun: () => ctx.commit(juncKey, make('spliced', junction.start, junction.end, junction.seq, name)),
        };
      }
      // Not exon-only: fine as the partner of a crossing primer, if it's one
      // continuous stretch of the gene (e.g. in an intron).
      if (partnerCrosses && inGene && contiguous) {
        return {
          ...base,
          disabledReason: primerLen,
          hint: [replaces(juncKey), `${partner!.name ?? 'partner'} crosses the junction`].filter(Boolean).join(' · '),
          onRun: () => ctx.commit(juncKey, make('gene', contiguous.start, contiguous.end, seq!, name)),
        };
      }
      return { ...base, disabledReason: partnerCrosses ? junction.reason : `${junction.reason} - the first junction primer must lie on exons and cross a junction` };
    }

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
      junctionEntry(),
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

  function probeSubmenu(): MenuEntry[] {
    const disabledReason = !inGene ? 'A probe must lie within the gene' : primerLen;
    const current = selections.geneProbe;
    const hint = current ? `replaces ${current.allele ? 'the allele probes' : (current.name ?? 'the current probe')}` : undefined;
    return [
      {
        shortcut: 'G',
        label: 'General',
        disabledReason,
        hint,
        onRun: () => contiguous && ctx.commit('geneProbe', { region: 'gene', start: contiguous.start, end: contiguous.end, primerSeq: seq!, bindingSeq: seq!, source: 'manual', strand: 'F', name: 'Probe' }),
      },
      {
        shortcut: 'A',
        label: 'Allele detection (wild type / mutant)',
        disabledReason,
        hint: hint ?? 'then pick the SNP base',
        // A searched rsID is only proposed as a probe's SNP when the probe pair
        // doesn't exist yet - searching after the pair was made must leave it as is.
        onRun: () =>
          contiguous && ctx.openAlleleProbe({ start: contiguous.start, end: contiguous.end, seq: seq!, snpSuggestion: selections.geneProbe?.allele ? undefined : ctx.rsSuggestion }),
      },
    ];
  }

  const anyPrimer = kinds.size > 0;
  return {
    heading,
    entries: [
      // F/R here mean "reads on the + / - strand OF THIS VIEW" - on a
      // minus-strand gene's default (plus) view, a paper's mRNA-"sense"
      // primer is the reverse one, so spelling the strand out prevents
      // picking template reads instead of the intended oligos.
      { shortcut: 'F', label: `Select as forward primer (${strandLabel} strand)`, disabledReason: anyPrimer ? null : 'Primer picks are not available in this view', submenu: primerSubmenu('F') },
      { shortcut: 'R', label: `Select as reverse primer (${strandLabel} strand)`, disabledReason: anyPrimer ? null : 'Primer picks are not available in this view', submenu: primerSubmenu('R') },
      {
        shortcut: 'P',
        label: 'Select as probe',
        disabledReason: !kinds.has('probe') ? 'Probe picks are not available in this view' : null,
        submenu: probeSubmenu(),
      },
      { shortcut: 'B', label: 'BLAST', disabledReason: seq ? lengthReason(len, LIMITS.blast) : 'Select one continuous stretch (or exactly across a collapsed intron)', onRun: () => seq && ctx.openBlast(seq) },
      { shortcut: 'S', label: 'Secondary structures', disabledReason: seq ? lengthReason(len, LIMITS.structure) : 'Select one continuous stretch (or exactly across a collapsed intron)', onRun: () => seq && ctx.openStructures(seq) },
    ],
  };
}

/** Heading + entries for the right-click menu on a rendered primer/probe
 * span (no text selection needed): BLAST and secondary structures on the
 * pick's own sequence. No length gates - a rendered pick already passed
 * the primer-length limits when it was made. */
export function buildPrimerMenu(sel: Selection, label: string, openBlast: (seq: string) => void, openStructures: (seq: string) => void): { heading: string; entries: MenuEntry[] } {
  return {
    heading: `${label} · ${sel.primerSeq.length} bp`,
    entries: [
      { shortcut: 'B', label: 'BLAST', disabledReason: null, onRun: () => openBlast(sel.primerSeq) },
      { shortcut: 'S', label: 'Secondary structures', disabledReason: null, onRun: () => openStructures(sel.primerSeq) },
    ],
  };
}
