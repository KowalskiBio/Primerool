import { useMemo, useState } from 'react';
import type { BlastHit } from '../api/blast';
import type { PrimerHitAssessment } from '../utils/primerAlignment';
import { findSharedTargets, genesAtHit, MAX_PRODUCT_BP, rankOffTargetHits, type GenesOf, type RankedHit, type SharedTarget, type SharedTargetVerdict } from '../utils/primerPairHits';
import { hitGenesKey, useHitGenes, useTargetNames } from '../utils/hitGenes';
import { flankKey, useHitFlanks } from '../utils/useHitFlanks';
import Modal from './ui/Modal';
import Badge from './ui/Badge';
import PrimerHitAlignment from './PrimerHitAlignment';

const VERDICT: Record<SharedTargetVerdict, { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' }> = {
  amplifies: { label: 'Can amplify', tone: 'danger' },
  weak: { label: 'Weak product', tone: 'warning' },
  blocked: { label: 'Blocked by 3′ mismatches', tone: 'success' },
  'no-product': { label: 'No product', tone: 'neutral' },
};

/** How many of each primer's worst off-target hits show before "Show all". */
const TOP_OFF_TARGETS = 5;

const LEVEL_TONE = { perfect: 'danger', risk: 'danger', weak: 'warning', unlikely: 'success' } as const;

interface PrimerHits {
  primer: string;
  hits: BlastHit[];
}

/** One primer pair's BLAST results, as the dialog needs them. */
export interface PairBlast {
  title: string;
  gene: string;
  /** The designed amplicon's length - a shared target giving a product of
   * this size is the target locus itself (see `findSharedTargets`). */
  designedSize: number | null;
  /** Organism slug the pair was BLASTed against. */
  organism: string;
  fwd: PrimerHits;
  rev: PrimerHits;
}

interface Props {
  /** The pair to show, or `null` to keep the modal closed. */
  pair: PairBlast | null;
  onClose: () => void;
}

/** "lies in VEGFA": the gene the hit's record annotates at the hit,
 * which can differ from the gene its title names. */
function GeneAtHit({ hit, genesOf }: { hit: BlastHit; genesOf: GenesOf }) {
  const g = genesAtHit(hit, genesOf);
  return g ? (
    <span className="whitespace-nowrap text-[11px] font-medium text-ink" title="The gene this record annotates at the hit's position">
      lies in {g}
    </span>
  ) : null;
}

/** Coverage and identity over the whole primer, in one line. (No
 * E-value: a perfect 20-nt match already scores E ~ 1 against `nt`, so it
 * says little about a primer hit.) */
function HitStats({ hit, assessment }: { hit: BlastHit; assessment: PrimerHitAssessment | null }) {
  const len = assessment ? Math.max(...assessment.columns.map((c) => c.qPos)) : hit.query_len;
  const matches = assessment ? assessment.columns.filter((c) => c.kind === 'match').length : null;
  return (
    <span className="whitespace-nowrap font-mono text-[11px] text-ink-muted tabular-nums" title="BLAST query cover · identical bases over the whole primer">
      cover {hit.query_cover}% · id {matches ?? '?'}/{len}
    </span>
  );
}

/** One primer's off-target hits, worst first - the top few, or all. */
function OffTargetList({ name, ranked, showAll, genesOf }: { name: string; ranked: RankedHit[]; showAll: boolean; genesOf: GenesOf }) {
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
                <HitStats hit={hit} assessment={assessment} />
                <GeneAtHit hit={hit} genesOf={genesOf} />
              </div>
              <p className="mb-1.5 text-xs text-ink-muted" title={hit.title}>
                {hit.title}
              </p>
              {assessment && <PrimerHitAlignment hit={hit} assessment={assessment} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TargetCard({ t, genesOf }: { t: SharedTarget; genesOf: GenesOf }) {
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
            <div className="mb-0.5 flex flex-wrap items-center gap-x-2 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              {name}
              {side.assessment && (
                <span className="normal-case tracking-normal">
                  {side.assessment.label} - {side.assessment.reason}
                </span>
              )}
              <span className="normal-case tracking-normal">
                <HitStats hit={side.hit} assessment={side.assessment} />
              </span>
              <span className="normal-case tracking-normal">
                <GeneAtHit hit={side.hit} genesOf={genesOf} />
              </span>
            </div>
            {side.assessment ? <PrimerHitAlignment hit={side.hit} assessment={side.assessment} /> : <span className="text-xs text-ink-faint">No alignment returned - re-run BLAST to get one.</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One primer pair's BLAST off-targets: each primer's worst hits other
 * than the gene of interest, then every sequence both primers hit with the
 * product the pair would make there. Primer ends BLAST left unaligned are
 * filled in from NCBI as they arrive (see `useHitFlanks`), re-judging and
 * re-ranking the hits. */
export default function SharedTargetsModal({ pair, onClose }: Props) {
  const [showAll, setShowAll] = useState(false);
  const allHits = useMemo(() => (pair ? [...pair.fwd.hits, ...pair.rev.hits] : []), [pair]);
  const { flanks, needed, resolved } = useHitFlanks(allHits, pair !== null);
  const flanksOf = (hit: BlastHit) => flanks[flankKey(hit)];
  // Which gene each hit really lies in (its record's annotation at the
  // hit, not the title) and the target gene's other names - together they
  // decide what counts as the target.
  const genes = useHitGenes(allHits, pair !== null);
  const genesOf: GenesOf = (hit) => genes[hitGenesKey(hit)];
  const genesPending = pair ? allHits.filter((h) => !h.direct && !(hitGenesKey(h) in genes)).length : 0;
  const names = useTargetNames(pair?.gene ?? '', pair?.organism ?? 'homo_sapiens');
  const target = { gene: pair?.gene ?? '', names, genesOf };

  const targets = pair ? findSharedTargets(pair.fwd.primer, pair.fwd.hits, pair.rev.primer, pair.rev.hits, target, pair.designedSize, flanksOf) : [];
  const off = targets.filter((t) => !t.onTarget);
  const on = targets.filter((t) => t.onTarget);
  // Sequences the pair amplifies at the designed size are the target locus
  // itself (a BAC/PAC clone of it) - not "wrong" hits for either primer.
  const locus = new Set(targets.filter((t) => t.sameSizeAsTarget).map((t) => t.accession));
  const fwdRanked = pair ? rankOffTargetHits(pair.fwd.primer, pair.fwd.hits, target, locus, flanksOf) : [];
  const revRanked = pair ? rankOffTargetHits(pair.rev.primer, pair.rev.hits, target, locus, flanksOf) : [];
  const hidden = Math.max(0, fwdRanked.length - TOP_OFF_TARGETS) + Math.max(0, revRanked.length - TOP_OFF_TARGETS);
  const gene = pair?.gene ?? '';

  return (
    <Modal
      open={pair !== null}
      onClose={() => {
        setShowAll(false);
        onClose();
      }}
      title={pair ? `BLAST off-targets - ${pair.title}` : ''}
    >
      <h3 className="mb-1 text-sm font-semibold text-ink">Top off-target hits per primer</h3>
      <p className="mb-3 text-xs text-ink-muted">
        Each primer&rsquo;s hits other than {gene} and its locus (by the gene each hit&rsquo;s record annotates there, else its title), most likely to prime first: perfect matches, then intact 3′ ends, then weak, then blocked. A primer binding elsewhere alone makes no
        product, but it competes for primer and can pair with a third site. Per hit: BLAST query cover and identical bases over the whole primer.
      </p>
      {(needed > resolved || genesPending > 0) && (
        <p role="status" className="mb-3 text-xs text-accent">
          Looking up at NCBI which gene each hit lies in ({allHits.length - genesPending}/{allHits.length}) and the bases opposite unaligned primer ends ({resolved}/{needed}) - verdicts and order
          update as they arrive.
        </p>
      )}
      <div className="mb-3 grid gap-4 lg:grid-cols-2">
        <OffTargetList name="Forward" ranked={fwdRanked} showAll={showAll} genesOf={genesOf} />
        <OffTargetList name="Reverse" ranked={revRanked} showAll={showAll} genesOf={genesOf} />
      </div>
      {hidden > 0 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="mb-6 text-xs font-medium text-accent hover:underline">
          {showAll ? `Show the top ${TOP_OFF_TARGETS} per primer only` : `Show all ${fwdRanked.length + revRanked.length} off-target hits (both primers)`}
        </button>
      )}
      <h3 className="mb-1 mt-3 text-sm font-semibold text-ink">
        Sequences both primers hit, other than {gene} ({off.length})
      </h3>
      <p className="mb-3 text-xs text-ink-muted">
        A product needs the two bound on opposite strands, 3′ ends facing, at most {MAX_PRODUCT_BP.toLocaleString()} bp apart, and both able to prime (fewer than 2 mismatches in each primer&rsquo;s 3′-terminal 5
        nt). Only each primer&rsquo;s best alignment per sequence is known, so a second binding site on the same long sequence would be missed.
      </p>
      {off.length === 0 ? (
        <p className="mb-4 text-sm text-ink-muted">No other sequence is hit by both primers.</p>
      ) : (
        <div className="mb-5 grid gap-2">
          {off.map((t) => (
            <TargetCard key={t.accession} t={t} genesOf={genesOf} />
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
              <TargetCard key={t.accession} t={t} genesOf={genesOf} />
            ))}
          </div>
        </details>
      )}
    </Modal>
  );
}
