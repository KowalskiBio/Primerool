import { useEffect, useState } from 'react';
import { searchGene, type Transcript } from '../api/gene';
import { getSequence, type SequenceData } from '../api/sequence';
import { localGenePos, SNP_WORKFLOW_SPECIES } from './variantMapping';

function coverageCount(data: SequenceData, positions: number[]): number {
  return positions.filter((p) => localGenePos(data, p) !== null).length;
}

export interface UseGeneSequenceResult {
  data: SequenceData | null;
  error: string | null;
  transcripts: Transcript[];
  apiSourceUsed: 'ncbi' | 'ensembl' | null;
  loading: boolean;
  switching: boolean;
  /** Loads a different transcript for the already-resolved gene/source -
   * a no-op if the gene hasn't loaded yet or the id matches what's shown. */
  switchTranscript: (transcriptId: string) => void;
}

/** Fetches `gene`'s canonical transcript (NCBI, falling back to Ensembl) -
 * then, if it doesn't cover every position in `requiredPositions`, tries
 * every other transcript the gene has, in order, for one that does (keeping
 * whichever covers the most) - a gene's RefSeq/Ensembl-flagged "canonical"
 * transcript can span only part of its full genomic locus (e.g. OPRM1's
 * canonical transcript covers ~122kb of its ~236kb gene), so a genuinely
 * in-gene position can still fall outside it. Refetches whenever `gene` or
 * the set of `requiredPositions` changes (compared by value, not
 * reference) - shared by `SnpGeneMapModal.tsx` (every batch SNP on a gene)
 * and `AmpliconDetailModal.tsx` (one amplicon's own variant(s)). */
export function useGeneSequence(gene: string | null, requiredPositions: number[]): UseGeneSequenceResult {
  const [data, setData] = useState<SequenceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [apiSourceUsed, setApiSourceUsed] = useState<'ncbi' | 'ensembl' | null>(null);
  const [resultFor, setResultFor] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const positionsKey = requiredPositions
    .slice()
    .sort((a, b) => a - b)
    .join(',');
  const loadKey = gene ? `${gene}|${positionsKey}` : null;

  useEffect(() => {
    if (!gene) return;
    let cancelled = false;
    const positions = requiredPositions;

    async function load() {
      // NCBI first (matches this app's default gene source), falling back
      // to Ensembl on any failure.
      for (const apiSource of ['ncbi', 'ensembl'] as const) {
        try {
          const found = await searchGene({ gene_name: gene!, species: SNP_WORKFLOW_SPECIES, api_source: apiSource });
          const canonical = found.transcripts.find((t) => t.is_canonical) || found.transcripts[0];
          if (!canonical) continue;
          const canonicalSeq = await getSequence({
            gene_name: gene!,
            transcript_id: canonical.id,
            species: SNP_WORKFLOW_SPECIES,
            api_source: apiSource,
            upstream_bp: 200,
            downstream_bp: 200,
            include_introns: true,
            include_utr: false,
          });
          if (cancelled) return;

          let best = canonicalSeq;
          let bestCoverage = coverageCount(canonicalSeq, positions);
          if (bestCoverage < positions.length) {
            const others = found.transcripts.filter((t) => t.id !== canonical.id);
            for (const t of others) {
              if (bestCoverage >= positions.length) break;
              try {
                const seq = await getSequence({
                  gene_name: gene!,
                  transcript_id: t.id,
                  species: SNP_WORKFLOW_SPECIES,
                  api_source: apiSource,
                  upstream_bp: 200,
                  downstream_bp: 200,
                  include_introns: true,
                  include_utr: false,
                });
                if (cancelled) return;
                const coverage = coverageCount(seq, positions);
                if (coverage > bestCoverage) {
                  best = seq;
                  bestCoverage = coverage;
                }
              } catch {
                // try the next candidate
              }
            }
          }

          if (!cancelled) {
            setData(best);
            setTranscripts(found.transcripts);
            setApiSourceUsed(apiSource);
            setError(null);
            setResultFor(loadKey);
          }
          return;
        } catch {
          // try the next source
        }
      }
      if (!cancelled) {
        setData(null);
        setTranscripts([]);
        setApiSourceUsed(null);
        setError(`Couldn't load "${gene}" from either NCBI or Ensembl.`);
        setResultFor(loadKey);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  const loading = gene !== null && resultFor !== loadKey;
  const shownData = gene !== null && resultFor === loadKey ? data : null;
  const shownError = gene !== null && resultFor === loadKey ? error : null;

  async function switchTranscript(transcriptId: string) {
    if (!gene || !apiSourceUsed || transcriptId === data?.transcript_id) return;
    setSwitching(true);
    try {
      const seq = await getSequence({
        gene_name: gene,
        transcript_id: transcriptId,
        species: SNP_WORKFLOW_SPECIES,
        api_source: apiSourceUsed,
        upstream_bp: 200,
        downstream_bp: 200,
        include_introns: true,
        include_utr: false,
      });
      setData(seq);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(false);
    }
  }

  return { data: shownData, error: shownError, transcripts, apiSourceUsed, loading, switching, switchTranscript };
}
