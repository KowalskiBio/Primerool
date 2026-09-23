import { useEffect, useState } from 'react';
import { analyzeStructure, type FullStructureAnalysis } from '../api/structure';
import Modal from './ui/Modal';
import HairpinSvg from './HairpinSvg';
import DimerAscii from './DimerAscii';
import { VariantBox } from './PrimerCard';

interface Props {
  /** The primer to analyze, or `null` to keep the modal closed. `label`
   * identifies it in the title (e.g. an rsID + "forward"/"reverse"). */
  primer: { label: string; sequence: string } | null;
  onClose: () => void;
}

/** Click-a-primer-on-the-amplicon-map structure viewer - the same
 * dual-model (bulge-allowing MFE vs. no-bulge sliding-window) hairpin/
 * self-dimer breakdown `PrimerCard.tsx` shows for a selected design
 * candidate, ported from Oligool's own analyzeStriderIndividual view, just
 * triggered from a click on the SNP-batch amplicon map instead of the
 * primer-design panels. */
export default function PrimerStructureModal({ primer, onClose }: Props) {
  const [structure, setStructure] = useState<FullStructureAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which sequence `structure`/`error` actually belong to - see
  // `SnpGeneMapModal.tsx`'s `resultFor` for the same pattern (avoids
  // calling setState synchronously inside the effect body).
  const [resultFor, setResultFor] = useState<string | null>(null);

  useEffect(() => {
    if (!primer) return;
    let cancelled = false;
    analyzeStructure({ sequence: primer.sequence })
      .then((res) => {
        if (cancelled) return;
        setStructure(res);
        setError(null);
        setResultFor(primer.sequence);
      })
      .catch((e) => {
        if (cancelled) return;
        setStructure(null);
        setError(e instanceof Error ? e.message : String(e));
        setResultFor(primer.sequence);
      });
    return () => {
      cancelled = true;
    };
  }, [primer]);

  const loading = primer !== null && resultFor !== primer.sequence;
  const shown = primer !== null && resultFor === primer.sequence ? structure : null;
  const shownError = primer !== null && resultFor === primer.sequence ? error : null;

  return (
    <Modal open={primer !== null} onClose={onClose} title={primer ? `${primer.label} - secondary structure` : ''}>
      {primer && (
        <p className="mb-3 break-all font-mono text-sm text-ink">
          {primer.sequence} <span className="text-ink-faint">({primer.sequence.length} bp)</span>
        </p>
      )}
      {loading && <p className="text-sm text-ink-muted">Analyzing…</p>}
      {shownError && (
        <div role="alert" className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">
          {shownError}
        </div>
      )}
      {shown && primer && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <VariantBox
            label="Hairpin - with bulges (Strider MFE)"
            variant={shown.hairpin.with_bulge}
            diagram={shown.hairpin.with_bulge.structure && <HairpinSvg sequence={primer.sequence} structure={shown.hairpin.with_bulge.structure} />}
          />
          <VariantBox
            label="Hairpin - no bulge (pure sliding)"
            variant={shown.hairpin.no_bulge}
            diagram={shown.hairpin.no_bulge.structure && <HairpinSvg sequence={primer.sequence} structure={shown.hairpin.no_bulge.structure} />}
          />
          <VariantBox
            label="Self-dimer - with bulges (Strider MFE)"
            variant={shown.homodimer.with_bulge}
            diagram={shown.homodimer.with_bulge.structure && <DimerAscii seq1={primer.sequence} seq2={primer.sequence} structure={shown.homodimer.with_bulge.structure} />}
          />
          <VariantBox
            label="Self-dimer - no bulge (pure sliding)"
            variant={shown.homodimer.no_bulge}
            diagram={shown.homodimer.no_bulge.structure && <DimerAscii seq1={primer.sequence} seq2={primer.sequence} structure={shown.homodimer.no_bulge.structure} />}
          />
        </div>
      )}
    </Modal>
  );
}
