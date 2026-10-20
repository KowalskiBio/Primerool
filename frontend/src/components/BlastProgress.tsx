/** The "Running NCBI BLAST…" status box with its progress bar. */
export default function BlastProgress({ progress }: { progress: number }) {
  return (
    <div className="mt-4 rounded-md border border-line bg-surface-2 px-4 py-3" role="status">
      <div className="mb-2 flex items-baseline gap-2">
        <strong className="text-sm text-ink">Running NCBI BLAST…</strong>
        <span className="text-sm text-ink-muted">This may take up to 2 minutes. Please wait.</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
