import type { BlastHit } from '../api/blast';
import Button from './ui/Button';

interface Props {
  hits: BlastHit[];
  onUse: (hit: BlastHit) => void;
}

export default function BlastResultsTable({ hits, onUse }: Props) {
  const top = hits.slice(0, 10);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm text-ink-muted">
        <thead className="text-xs uppercase text-ink-muted bg-surface-2">
          <tr>
            <th className="border-b border-line px-4 py-3 font-medium">#</th>
            <th className="border-b border-line px-4 py-3 font-medium">Organism</th>
            <th className="border-b border-line px-4 py-3 font-medium">Gene</th>
            <th className="border-b border-line px-4 py-3 font-medium">Description</th>
            <th className="border-b border-line px-4 py-3 font-medium">Accession</th>
            <th className="border-b border-line px-4 py-3 font-medium">Query Cover</th>
            <th className="border-b border-line px-4 py-3 font-medium">Identity</th>
            <th className="border-b border-line px-4 py-3 font-medium">E-value</th>
            <th className="border-b border-line px-4 py-3 font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {top.map((hit, i) => (
            <tr key={`${hit.accession}-${i}`} className="border-b border-line bg-surface text-xs last:border-0 hover:bg-surface-2">
              <td className="px-4 py-3 tabular-nums">{i + 1}</td>
              <td className="px-4 py-3">
                <em>{hit.organism}</em>
              </td>
              <td className="px-4 py-3">
                <strong className="font-medium text-ink">{hit.gene_symbol || <span className="text-ink-faint">-</span>}</strong>
              </td>
              <td className="px-4 py-3">
                <div className="min-w-[200px]" title={hit.title}>
                  {hit.title}
                </div>
              </td>
              <td className="px-4 py-3 font-mono">
                <a href={`https://www.ncbi.nlm.nih.gov/nuccore/${hit.accession}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {hit.accession}
                </a>
              </td>
              <td className="px-4 py-3 tabular-nums">{hit.query_cover ?? '-'}%</td>
              <td className="px-4 py-3 tabular-nums">{hit.identity_pct}%</td>
              <td className="px-4 py-3 tabular-nums">{hit.evalue !== null ? hit.evalue.toExponential(1) : '-'}</td>
              <td className="px-4 py-3">
                <Button size="sm" onClick={() => onUse(hit)}>
                  Use
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
