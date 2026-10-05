import { useState } from 'react';
import type { BlastHit } from '../api/blast';
import { MAX_PRODUCT_BP, rankOffTargetHits, type RankedHit, type SharedTarget, type SharedTargetVerdict } from '../utils/primerPairHits';
import Modal from './ui/Modal';
import Badge from './ui/Badge';
import PrimerHitAlignment from './PrimerHitAlignment';

const VERDICT: Record<SharedTargetVerdict, { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' }> = {
  amplifies: { label: 'Can amplify', tone: 'danger' },
  weak: { label: 'Weak product', tone: 'warning' },
  blocked: { label: "Blocked by 3′ mismatches", tone: 'success' },
  'no-product': { label: 'No product', tone: 'neutral' },
};

/** How many of each primer's worst off-target hits show before "Show all". */
const TOP_OFF_TARGETS = 5;

const LEVEL_TONE = { perfect: 'danger', risk: 'danger', weak: 'warning', unlikely: 'success' } as const;

interface PrimerHits {
  primer: string;
  hits: BlastHit[];
}

interface Props {
  /** The pair's shared targets, or `null` to keep the modal closed. */
  targets: SharedTarget[] | null;
  /** Each primer's own BLAST hits - for its top off-target hits, which
   * matter even where the other primer doesn't bind. */
  fwd: PrimerHits | null;
  rev: PrimerHits | null;
  title: string;
  gene: string;
  onClose: () => void;
}

/** One primer's off-target hits, worst first: the top few, the rest on
 * demand. */
function OffTargetList({ name, ranked }: { name: string; ranked: RankedHit[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? ranked : ranked.slice(0, TOP_OFF_TARGETS);
  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
        {name} primer ({ranked.length})
      </h4>
      {ranked.length === 0 ? (
        <p className="text-sm text-ink-muted">No hits other than the target.</p>
      ) : (
        <div className="grid gap-2">
          {shown.map(({ hit, assessment }, i) => (
            <div key={`${hit.accession}-${i}`} className="rounded-md border border-line bg-surface px-3 py-2">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                {assessment ? (
                  <Badge tone={LEVEL_TONE[assessment.level]} className="whitespace-nowrap">
                    {assessment.level === 'perfect' ? 'Perfect match elsewhere' : assessment.label}
                  </Badge>
                ) : (
                  <Badge tone="neutral">no alignment</Badge>
                )}
                {assessment && <span className="text-ink-faint">{assessment.reason}</span>}
                <a href={`https://www.ncbi.nlm.nih.gov/nuccore/${hit.accession}`} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">
                  {hit.accession}
                </a>
              </div>
              <p className="mb-1.5 text-xs text-ink-muted" title={hit.title}>
                {hit.title}
              </p>
              {assessment && <PrimerHitAlignment hit={hit} assessment={assessment} />}
            </div>
          ))}
          {ranked.length > TOP_OFF_TARGETS && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="justify-self-start text-xs text-accent hover:underline">
              {showAll ? `Show top ${TOP_OFF_TARGETS} only` : `Show all ${ranked.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
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
export default function SharedTargetsModal({ targets, fwd, rev, title, gene, onClose }: Props) {
  const off = (targets ?? []).filter((t) => !t.onTarget);
  const on = (targets ?? []).filter((t) => t.onTarget);
  // Sequences the pair amplifies at the designed size are the target locus
  // itself (a BAC/PAC clone of it) - not "wrong" hits for either primer.
  const locus = new Set((targets ?? []).filter((t) => t.sameSizeAsTarget).map((t) => t.accession));
  return (
    <Modal open={targets !== null} onClose={onClose} title={`BLAST off-targets - ${title}`}>
      <h3 className="mb-1 text-sm font-semibold text-ink">Top off-target hits per primer</h3>
      <p className="mb-3 text-xs text-ink-muted">
        Each primer&rsquo;s hits other than {gene} and its locus, most likely to prime first: perfect matches, then intact 3′ ends, then weak, then blocked. A primer binding elsewhere alone makes no
        product, but it competes for primer and can pair with a third site.
      </p>
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        {fwd && <OffTargetList name="Forward" ranked={rankOffTargetHits(fwd.primer, fwd.hits, gene, locus)} />}
        {rev && <OffTargetList name="Reverse" ranked={rankOffTargetHits(rev.primer, rev.hits, gene, locus)} />}
      </div>
      <h3 className="mb-1 text-sm font-semibold text-ink">Sequences both primers hit, other than {gene} ({off.length})</h3>
      <p className="mb-3 text-xs text-ink-muted">
        Sequences both primers hit. A product needs the two bound on opposite strands, 3′ ends facing, at most {MAX_PRODUCT_BP.toLocaleString()} bp apart, and both able to prime (fewer than 2 mismatches in each
        primer&rsquo;s 3′-terminal 5 nt). Only each primer&rsquo;s best alignment per sequence is known, so a second binding site on the same long sequence would be missed.
      </p>
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
