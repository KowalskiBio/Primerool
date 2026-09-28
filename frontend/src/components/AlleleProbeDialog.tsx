import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AlleleProbeRequest } from '../utils/mapPickMenu';
import Button from './ui/Button';
import TextInput from './ui/TextInput';

interface Props {
  /** The pending probe pick, or `null` when closed. */
  request: AlleleProbeRequest | null;
  /** 1-based gene position label of a gene-local index. */
  posLabel: (pos: number) => string;
  onConfirm: (snpPos: number, mutBase: string, wtName: string, mutName: string) => void;
  onCancel: () => void;
}

const BASES = ['A', 'C', 'G', 'T'] as const;

/** Asks which base of an allele-detection probe is the SNP, its second
 * (mutant) allele and the two probes' names. The wild-type probe matches
 * the template; the mutant probe is identical except at the SNP. Same
 * small centred shape as `ArmsTwinDialog`. */
export default function AlleleProbeDialog({ request, posLabel, onConfirm, onCancel }: Props) {
  if (!request) return null;
  // Keyed on the pick so each opening starts from fresh defaults.
  return <DialogBody key={`${request.start}-${request.end}`} request={request} posLabel={posLabel} onConfirm={onConfirm} onCancel={onCancel} />;
}

function DialogBody({ request, posLabel, onConfirm, onCancel }: Props & { request: AlleleProbeRequest }) {
  const seq = request.seq.toUpperCase();
  const [snpIdx, setSnpIdx] = useState<number | null>(null);
  const [mut, setMut] = useState<string | null>(null);
  const [wtName, setWtName] = useState('P-WT');
  const [mutName, setMutName] = useState('P-MUT');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const wt = snpIdx === null ? null : seq[snpIdx];

  function pickBase(i: number) {
    setSnpIdx(i);
    // Keep a still-valid mutant choice, else default to the first other base.
    if (mut === null || mut === seq[i]) setMut(BASES.find((b) => b !== seq[i]) ?? null);
  }

  const ready = snpIdx !== null && mut !== null;
  const confirm = () => {
    if (!ready) return;
    onConfirm(request.start + snpIdx, mut, wtName.trim() || 'P-WT', mutName.trim() || 'P-MUT');
  };

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
        aria-label="Allele-detection probes"
        className="w-full max-w-lg rounded-lg border border-line bg-surface p-5 text-sm text-ink shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <h2 className="mb-1 text-sm font-semibold">Allele-detection probes</h2>
        <p className="mb-4 text-xs text-ink-muted">
          {seq.length} bp, positions {posLabel(request.start)}–{posLabel(request.end - 1)}. Click the base that differs between the alleles - the wild-type probe matches
          the template, the mutant probe carries the other allele there.
        </p>

        <div className="mb-4">
          <div className="mb-1.5 text-xs font-medium text-ink-muted">
            SNP base{snpIdx !== null && <span className="text-ink"> · position {posLabel(request.start + snpIdx)}</span>}
          </div>
          <div className="flex flex-wrap gap-0.5" role="radiogroup" aria-label="SNP base">
            {Array.from(seq).map((b, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={snpIdx === i}
                aria-label={`${b} at position ${posLabel(request.start + i)}`}
                title={`Position ${posLabel(request.start + i)}`}
                onClick={() => pickBase(i)}
                className={`h-7 w-6 rounded border font-mono text-[13px] font-semibold ${snpIdx === i ? 'border-accent bg-accent text-white' : 'border-line text-ink hover:bg-surface-2'}`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-1.5 text-xs font-medium text-ink-muted">Second (mutant) allele</div>
          <div className="flex gap-2" role="radiogroup" aria-label="Mutant allele">
            {BASES.map((b) => {
              const disabled = wt === null || b === wt;
              return (
                <button
                  key={b}
                  type="button"
                  role="radio"
                  aria-checked={mut === b}
                  disabled={disabled}
                  title={wt === null ? 'Pick the SNP base first' : b === wt ? 'This is the wild-type base' : undefined}
                  onClick={() => setMut(b)}
                  className={`h-9 w-11 rounded-md border font-mono text-sm font-semibold ${
                    disabled ? 'cursor-not-allowed border-line text-ink-faint' : mut === b ? 'border-accent bg-accent text-white' : 'border-line-strong text-ink hover:bg-surface-2'
                  }`}
                >
                  {b}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-ink-muted">
            Wild-type probe{wt && ` (${wt})`}
            <TextInput className="mt-1.5" value={wtName} onChange={(e) => setWtName(e.target.value)} />
          </label>
          <label className="text-xs font-medium text-ink-muted">
            Mutant probe{wt && mut && ` (${mut})`}
            <TextInput className="mt-1.5" value={mutName} onChange={(e) => setMutName(e.target.value)} />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            Create probes
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
