import StructureArcSvg from './StructureArcSvg';

interface Props {
  seq1: string;
  seq2: string;
  /** Dot-bracket structure over the concatenated `seq1 + seq2`, as returned
   * by `thermo_core::thermo::DimerThermo.structure`. */
  structure: string;
}

/** Renders a bimolecular (self- or hetero-) dimer alignment — the two
 * strands drawn as one sequence with a visual break at the strand
 * boundary (see `StructureArcSvg`'s docs for the layout approach). */
export default function DimerSvg({ seq1, seq2, structure }: Props) {
  return <StructureArcSvg sequence={seq1 + seq2} structure={structure} splitIndex={seq1.length} />;
}
