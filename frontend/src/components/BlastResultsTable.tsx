import type { BlastHit } from '../api/blast';

interface Props {
  hits: BlastHit[];
  onUse: (hit: BlastHit) => void;
}

export default function BlastResultsTable({ hits, onUse }: Props) {
  const top = hits.slice(0, 10);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm text-left text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg">
        <thead className="text-xs text-slate-700 dark:text-slate-300 uppercase bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900">
          <tr>
            <th className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">#</th>
            <th className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">Organism</th>
            <th className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">Gene</th>
            <th className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">Description</th>
            <th className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">Accession</th>
            <th className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">Query Cover</th>
            <th className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">Identity</th>
            <th className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">E-value</th>
            <th className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">Action</th>
          </tr>
        </thead>
        <tbody>
          {top.map((hit, i) => (
            <tr key={`${hit.accession}-${i}`} className="bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 hover:bg-green-50/50 dark:hover:bg-slate-700/50 last:border-0 text-xs">
              <td className="px-4 py-3">{i + 1}</td>
              <td className="px-4 py-3">
                <em>{hit.organism}</em>
              </td>
              <td className="px-4 py-3">
                <strong>{hit.gene_symbol || <span className="text-slate-400">-</span>}</strong>
              </td>
              <td className="px-4 py-3">
                <div className="min-w-[200px]" title={hit.title}>
                  {hit.title}
                </div>
              </td>
              <td className="px-4 py-3">
                <a href={`https://www.ncbi.nlm.nih.gov/nuccore/${hit.accession}`} target="_blank" rel="noreferrer" className="text-green-600 hover:underline">
                  {hit.accession}
                </a>
              </td>
              <td className="px-4 py-3">{hit.query_cover ?? '-'}%</td>
              <td className="px-4 py-3">{hit.identity_pct}%</td>
              <td className="px-4 py-3">{hit.evalue !== null ? hit.evalue.toExponential(1) : '-'}</td>
              <td className="px-4 py-3">
                <button
                  className="px-2 py-1 text-xs font-medium text-white bg-slate-800 rounded hover:bg-slate-700 transition"
                  onClick={() => onUse(hit)}
                >
                  Use
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
