import { MAX_PRODUCT_BP, type SharedTarget, type SharedTargetVerdict } from '../utils/primerPairHits';
import Modal from './ui/Modal';
import Badge from './ui/Badge';
import PrimerHitAlignment from './PrimerHitAlignment';

const VERDICT: Record<SharedTargetVerdict, { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' }> = {
  amplifies: { label: 'Can amplify', tone: 'danger' },
  weak: { label: 'Weak product', tone: 'warning' },
  blocked: { label: "Blocked by 3′ mismatches", tone: 'success' },
  'no-product': { label: 'No product', tone: 'neutral' },
};

interface Props {
  /** The pair's shared targets, or `null` to keep the modal closed. */
  targets: SharedTarget[] | null;
  title: string;
  gene: string;
  onClose: () => void;
}

function TargetCard({ t }: { t: SharedTarget }) {
  const verdict = VERDICT[t.verdict];
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={t.onTarget ? 'accent' : verdict.tone} className="whitespace-nowrap">
          {verdict.label}
        </Badge>
        {t.productSize !== null ? (
          <span className="font-medium text-ink tabular-nums">{t.productSize.toLocaleString()} bp product</span>
        ) : (
          <span className="text-ink-faint">primers not facing each other within {MAX_PRODUCT_BP.toLocaleString()} bp</span>
        )}
        {t.sameSizeAsTarget && !t.onTarget && <Badge tone="neutral">same size as the designed amplicon - likely the target locus</Badge>}
        <a href={`https://www.ncbi.nlm.nih.gov/nuccore/${t.accession}`} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">
          {t.accession}
        </a>
      </div>
      <p className="mb-2 text-xs text-ink-muted">
        <em>{t.organism}</em> - {t.title}
      </p>
      <div className="grid gap-2">
        {(
          [
            ['Forward', t.fwd],
            ['Reverse', t.rev],
          ] as const
        ).map(([name, side]) => (
          <div key={name}>
            <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              {name}
              {side.assessment && <span className="ml-2 normal-case tracking-normal">{side.assessment.label} - {side.assessment.reason}</span>}
            </div>
            {side.assessment ? <PrimerHitAlignment hit={side.hit} assessment={side.assessment} /> : <span className="text-xs text-ink-faint">No alignment returned - re-run BLAST to get one.</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Every sequence both primers of one pair hit, each with the product the
 * pair would make there - off-target products first, then the gene of
 * interest's own records. */
export default function SharedTargetsModal({ targets, title, gene, onClose }: Props) {
  const off = (targets ?? []).filter((t) => !t.onTarget);
  const on = (targets ?? []).filter((t) => t.onTarget);
  return (
    <Modal open={targets !== null} onClose={onClose} title={`Shared BLAST targets - ${title}`}>
      <p className="mb-4 text-xs text-ink-muted">
        Sequences both primers hit. A product needs the two bound on opposite strands, 3′ ends facing, at most {MAX_PRODUCT_BP.toLocaleString()} bp apart, and both able to prime (fewer than 2 mismatches in each
        primer&rsquo;s 3′-terminal 5 nt). Only each primer&rsquo;s best alignment per sequence is known, so a second binding site on the same long sequence would be missed.
      </p>
      <h3 className="mb-2 text-sm font-semibold text-ink">Other than {gene} ({off.length})</h3>
      {off.length === 0 ? (
        <p className="mb-4 text-sm text-ink-muted">No other sequence is hit by both primers.</p>
      ) : (
        <div className="mb-5 grid gap-2">
          {off.map((t) => (
            <TargetCard key={t.accession} t={t} />
          ))}
        </div>
      )}
      {on.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none text-sm font-semibold text-ink">
            {gene} itself ({on.length})
          </summary>
          <div className="mt-2 grid gap-2">
            {on.map((t) => (
              <TargetCard key={t.accession} t={t} />
            ))}
          </div>
        </details>
      )}
    </Modal>
  );
}
