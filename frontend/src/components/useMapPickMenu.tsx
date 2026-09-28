import { useState, type ReactNode } from 'react';
import type { SequenceData } from '../api/sequence';
import { analyzePrimer } from '../api/design';
import type { Selection, Selections } from '../utils/regionMapping';
import { resolveMapSelection, type MapPick } from '../utils/mapSelection';
import { buildPickMenu, createAlleleProbes, createArmsTwins, genePosLabel, type AlleleProbeRequest, type ArmsTwinRequest, type PickKind } from '../utils/mapPickMenu';
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
}

/** The right-click menu over a selected stretch of a sequence map, shared
 * by the genomic map (`SequenceViewer`) and the Exon map
 * (`SplicedSequenceViewer`): spread `onContextMenu` onto the map's scroll
 * container and render `overlay` anywhere in the component.
 *
 * Also owns `commitSelection` - set a pick, then fill in its Strider
 * analysis - which `SequenceViewer`'s drag-resize reuses. */
export function useMapPickMenu({ data, selections, onSelect, pickKinds }: Options) {
  const [menu, setMenu] = useState<{ x: number; y: number; target: MapPick | { error: string } } | null>(null);
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
    const target = resolveMapSelection(e.currentTarget);
    if (!target) return; // nothing selected in the map - keep the browser's own menu
    e.preventDefault();
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

  const model =
    menu && !('error' in menu.target)
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
        })
      : null;

  const overlay: ReactNode = (
    <>
      {menu && (
        <SequenceContextMenu
          x={menu.x}
          y={menu.y}
          heading={model?.heading ?? ''}
          error={'error' in menu.target ? menu.target.error : undefined}
          entries={model?.entries ?? []}
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
