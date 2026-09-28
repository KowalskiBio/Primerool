import { useState, type ReactNode } from 'react';
import type { SequenceData } from '../api/sequence';
import { analyzePrimer } from '../api/design';
import type { Selection, Selections } from '../utils/regionMapping';
import { resolveMapSelection, type MapPick } from '../utils/mapSelection';
import { buildPickMenu, buildPrimerMenu, createAlleleProbes, createArmsTwins, genePosLabel, type AlleleProbeRequest, type ArmsTwinRequest, type PickKind, type RsSnpSuggestion } from '../utils/mapPickMenu';
import SequenceContextMenu from './SequenceContextMenu';
import ArmsTwinDialog from './ArmsTwinDialog';
import AlleleProbeDialog from './AlleleProbeDialog';
import BlastModal from './BlastModal';
import PrimerStructureModal from './PrimerStructureModal';

interface Options {
  data: SequenceData;
  selections: Selections;
  /** Absent: the menu still offers BLAST/structures, but no picks. */
  onSelect?: (key: keyof Selections, value: Selection | null) => void;
  pickKinds: readonly PickKind[];
  /** The rsID currently located by the map's "Find in sequence" search, if
   * any - forwarded to the pick menu, which offers it as a new allele-probe
   * pair's SNP. */
  rsSuggestion?: RsSnpSuggestion;
  /** Rewrites a text selection before the menu is built - the Exon map
   * turns one lying within a single exon into the same gene stretch, so it
   * gets the genomic map's picks (general, ARMS, probe), not only junction
   * ones. */
  translatePick?: (pick: MapPick) => MapPick;
}

/** Heading labels for the per-pick menu, for picks with no user-given
 * name - matching the names `buildPickMenu`'s picks get by default. */
const PICK_LABELS: Record<keyof Selections, string> = {
  wgaForward: 'WGA-F',
  wgaReverse: 'WGA-R',
  juncLeft: 'J-F',
  juncRight: 'J-R',
  geneForward: 'F',
  geneReverse: 'R',
  geneProbe: 'Probe',
  geneProbeAlt: 'Mutant probe',
  armsRefPrimer: 'ARMS WT twin',
  armsAltPrimer: 'ARMS mutant twin',
  armsCommon: 'ARMS common primer',
};

/** The right-click menu over a selected stretch of a sequence map, shared
 * by the genomic map (`SequenceViewer`) and the Exon map
 * (`SplicedSequenceViewer`): spread `onContextMenu` onto the map's scroll
 * container and render `overlay` anywhere in the component.
 *
 * Also owns `commitSelection` - set a pick, then fill in its Strider
 * analysis - which both maps' drag-resize reuses. */
export function useMapPickMenu({ data, selections, onSelect, pickKinds, rsSuggestion, translatePick }: Options) {
  const [menu, setMenu] = useState<{ x: number; y: number; target: MapPick | { error: string } | { pickKey: keyof Selections } } | null>(null);
  const [blastSeq, setBlastSeq] = useState<string | null>(null);
  const [structureSeq, setStructureSeq] = useState<string | null>(null);
  const [armsRequest, setArmsRequest] = useState<ArmsTwinRequest | null>(null);
  const [alleleRequest, setAlleleRequest] = useState<AlleleProbeRequest | null>(null);

  /** Sets a primer/probe pick, then fills in its Strider analysis (Tm/GC/
   * hairpin/self-dimer) with a second `onSelect` once it arrives. A parent
   * reading `analysis === undefined` as "still computing" (e.g.
   * `AmpliconDetailModal`) sees both calls. */
  function commitSelection(key: keyof Selections, next: Selection) {
    if (!onSelect) return;
    onSelect(key, next);
    analyzePrimer({ sequence: next.primerSeq, engine: 'strider' }).then(
      (analysis) => onSelect(key, { ...next, analysis }),
      () => onSelect(key, { ...next, analysis: null }),
    );
  }

  const clear = (key: keyof Selections) => onSelect?.(key, null);

  function onContextMenu(e: React.MouseEvent<HTMLElement>) {
    // A right-click on a rendered primer/probe span opens that pick's own
    // menu (BLAST / secondary structures on its sequence), regardless of
    // any text selection.
    const pickEl = (e.target as HTMLElement).closest<HTMLElement>('[data-pick-key]');
    const pickKey = pickEl?.dataset.pickKey as keyof Selections | undefined;
    if (pickKey && selections[pickKey]) {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, target: { pickKey } });
      return;
    }
    const resolved = resolveMapSelection(e.currentTarget);
    if (!resolved) return; // nothing selected in the map - keep the browser's own menu
    e.preventDefault();
    const target = translatePick && !('error' in resolved) ? translatePick(resolved) : resolved;
    setMenu({ x: e.clientX, y: e.clientY, target });
  }

  /** Every menu action ends the same way: close the menu and drop the
   * text selection, so the new highlight is visible. */
  function afterMenu<A extends unknown[]>(fn: (...args: A) => void) {
    return (...args: A) => {
      setMenu(null);
      window.getSelection()?.removeAllRanges();
      fn(...args);
    };
  }

  /** The menu over a rendered primer/probe span: BLAST and secondary
   * structures on the pick's own sequence (see `buildPrimerMenu`). */
  const primerMenu =
    menu && 'pickKey' in menu.target && selections[menu.target.pickKey]
      ? buildPrimerMenu(
          selections[menu.target.pickKey]!,
          selections[menu.target.pickKey]!.name ?? PICK_LABELS[menu.target.pickKey],
          afterMenu((seq: string) => setBlastSeq(seq)),
          afterMenu((seq: string) => setStructureSeq(seq)),
        )
      : null;

  const model =
    menu && !('error' in menu.target) && !('pickKey' in menu.target)
      ? buildPickMenu({
          data,
          selections,
          pick: menu.target,
          kinds: new Set(onSelect ? pickKinds : []),
          commit: afterMenu(commitSelection),
          clear,
          openBlast: afterMenu(setBlastSeq),
          openStructures: afterMenu(setStructureSeq),
          openArmsTwins: afterMenu(setArmsRequest),
          openAlleleProbe: afterMenu(setAlleleRequest),
          rsSuggestion,
        })
      : null;

  const overlay: ReactNode = (
    <>
      {menu && (
        <SequenceContextMenu
          x={menu.x}
          y={menu.y}
          heading={model?.heading ?? primerMenu?.heading ?? ''}
          error={'error' in menu.target ? menu.target.error : undefined}
          entries={model?.entries ?? primerMenu?.entries ?? []}
          onClose={() => setMenu(null)}
        />
      )}
      <ArmsTwinDialog
        request={armsRequest}
        snpLabel={armsRequest ? genePosLabel(data, 'gene', armsRequest.snpPos) : ''}
        onCancel={() => setArmsRequest(null)}
        onConfirm={(mutBase, wtName, mutName) => {
          if (armsRequest) createArmsTwins({ data, selections, commit: commitSelection, clear }, armsRequest, mutBase, wtName, mutName);
          setArmsRequest(null);
        }}
      />
      <AlleleProbeDialog
        request={alleleRequest}
        posLabel={(pos) => genePosLabel(data, 'gene', pos)}
        onCancel={() => setAlleleRequest(null)}
        onConfirm={(snpPos, mutBase, wtName, mutName) => {
          if (alleleRequest) createAlleleProbes({ commit: commitSelection }, alleleRequest, snpPos, mutBase, wtName, mutName);
          setAlleleRequest(null);
        }}
      />
      <BlastModal sequence={blastSeq} onClose={() => setBlastSeq(null)} />
      <PrimerStructureModal pair={structureSeq ? { label: `${structureSeq.length} bp selection`, forward: structureSeq } : null} onClose={() => setStructureSeq(null)} />
    </>
  );

  return { onContextMenu, overlay, commitSelection, busy: menu !== null || armsRequest !== null || alleleRequest !== null };
}
