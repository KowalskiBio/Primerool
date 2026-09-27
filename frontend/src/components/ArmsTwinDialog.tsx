import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ArmsTwinRequest } from '../utils/mapPickMenu';
import Button from './ui/Button';
import TextInput from './ui/TextInput';

interface Props {
  /** The pending twin pick, or `null` when closed. */
  request: ArmsTwinRequest | null;
  /** 1-based gene position label of the SNP, for the description line. */
  snpLabel: string;
  onConfirm: (mutBase: string, wtName: string, mutName: string) => void;
  onCancel: () => void;
}

const BASES = ['A', 'C', 'G', 'T'] as const;

/** Asks for the second (mutant) allele of an ARMS twin pair and the twins'
 * names. The wild-type twin's 3' base is the template base at the SNP;
 * the mutant twin is identical except its 3' base carries the chosen
 * allele. Small and centred - not the app's full-height `Modal`. */
export default function ArmsTwinDialog({ request, snpLabel, onConfirm, onCancel }: Props) {
  if (!request) return null;
  // Keyed on the pick so each opening starts from fresh defaults.
  return <DialogBody key={`${request.strand}${request.start}-${request.end}`} request={request} snpLabel={snpLabel} onConfirm={onConfirm} onCancel={onCancel} />;
}

function DialogBody({ request, snpLabel, onConfirm, onCancel }: Props & { request: ArmsTwinRequest }) {
  const wt = request.wtBase.toUpperCase();
  const [mut, setMut] = useState<string>(BASES.find((b) => b !== wt) ?? 'A');
  const [wtName, setWtName] = useState('A1');
  const [mutName, setMutName] = useState('A2');
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const fwd = request.strand === 'F';
  const confirm = () => onConfirm(mut, wtName.trim() || 'A1', mutName.trim() || 'A2');

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="ARMS allele-specific twins"
        className="w-full max-w-md rounded-lg border border-line bg-surface p-5 text-sm text-ink shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <h2 className="mb-1 text-sm font-semibold">ARMS allele-specific twins ({fwd ? 'forward' : 'reverse'})</h2>
        <p className="mb-4 text-xs text-ink-muted">
          {request.end - request.start} bp, 3&apos; end locked on the SNP at position {snpLabel} (wild-type base <span className="font-mono font-semibold text-ink">{wt}</span>). Dragging
          later moves only the 5&apos; end.
        </p>

        <div className="mb-4">
          <div className="mb-1.5 text-xs font-medium text-ink-muted">Second (mutant) allele</div>
          <div className="flex gap-2" role="radiogroup" aria-label="Mutant allele">
            {BASES.map((b, i) => (
              <button
                key={b}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                role="radio"
                aria-checked={mut === b}
                disabled={b === wt}
                title={b === wt ? 'This is the wild-type base' : undefined}
                onClick={() => setMut(b)}
                className={`h-9 w-11 rounded-md border font-mono text-sm font-semibold ${
                  b === wt ? 'cursor-not-allowed border-line text-ink-faint' : mut === b ? 'border-accent bg-accent text-white' : 'border-line-strong text-ink hover:bg-surface-2'
                }`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-ink-muted">
            Wild-type twin ({wt})
            <TextInput className="mt-1.5" value={wtName} onChange={(e) => setWtName(e.target.value)} />
          </label>
          <label className="text-xs font-medium text-ink-muted">
            Mutant twin ({mut})
            <TextInput className="mt-1.5" value={mutName} onChange={(e) => setMutName(e.target.value)} />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Create twins
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
