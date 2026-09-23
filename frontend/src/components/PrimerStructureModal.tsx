import Modal from './ui/Modal';
import PrimerStructurePanel from './PrimerStructurePanel';

interface Props {
  /** The pair to analyze, or `null` to keep the modal closed. */
  pair: { label: string; forward: string; reverse: string } | null;
  onClose: () => void;
}

/** Click-a-primer-on-the-amplicon-map structure viewer - a standalone
 * popup wrapping `PrimerStructurePanel` (the same content
 * `AmpliconDetailModal.tsx` embeds inline below its sequence map). */
export default function PrimerStructureModal({ pair, onClose }: Props) {
  return (
    <Modal open={pair !== null} onClose={onClose} title={pair ? `${pair.label} - primer structures` : ''}>
      <PrimerStructurePanel pair={pair} />
    </Modal>
  );
}
