import StructureArcSvg from './StructureArcSvg';

interface Props {
  sequence: string;
  /** Dot-bracket structure over `sequence`, as returned by
   * `thermo_core::thermo::HairpinThermo.structure`. */
  structure: string;
}

/** Renders a single-molecule hairpin fold (see `StructureArcSvg`'s docs for
 * the layout approach). */
export default function HairpinSvg({ sequence, structure }: Props) {
  return <StructureArcSvg sequence={sequence} structure={structure} />;
}
