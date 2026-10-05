import { useState, type MouseEvent } from 'react';
import SequenceContextMenu from './SequenceContextMenu';
import BlastModal from './BlastModal';

interface Props {
  sequence: string;
  /** Names the oligo in the menu heading, e.g. "Forward primer". */
  label?: string;
  className?: string;
}

/** A primer's sequence in a results table. Right-clicking it opens the
 * same menu the sequence map uses, offering to copy just that one oligo
 * or BLAST it - so each primer of a pair can be checked on its own. */
export default function PrimerSequence({ sequence, label = 'Primer', className = '' }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [blastSeq, setBlastSeq] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  function copy() {
    setMenu(null);
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(sequence)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }

  return (
    <>
      <span onContextMenu={openMenu} title="Right-click to copy or BLAST" className={`cursor-context-menu ${className}`}>
        {sequence}
      </span>
      {copied && <span className="ml-1.5 font-sans text-[11px] text-ink-muted">Copied</span>}
      {menu && (
        <SequenceContextMenu
          x={menu.x}
          y={menu.y}
          heading={`${label} · ${sequence.length} bp`}
          entries={[
            { shortcut: 'C', label: 'Copy sequence', disabledReason: navigator.clipboard ? null : 'Clipboard unavailable in this browser', onRun: copy },
            {
              shortcut: 'B',
              label: 'BLAST sequence',
              disabledReason: null,
              onRun: () => {
                setMenu(null);
                setBlastSeq(sequence);
              },
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
      {blastSeq && <BlastModal sequence={blastSeq} onClose={() => setBlastSeq(null)} />}
    </>
  );
}
