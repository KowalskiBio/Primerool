import type { DesignEngine } from '../api/design';

interface Props {
  value: DesignEngine;
  onChange: (engine: DesignEngine) => void;
}

/** Shared calc-engine picker for the design panels — matches Oligool's own
 * per-request `engine: "primer3"|"strider"` toggle. `"native"` is
 * thermo-core's from-scratch Rust engine: ~10x faster, Mathews2004-accurate
 * for hairpin/dimer Tm, but ranks candidate primers differently than
 * primer3 (see crates/engine/native_vs_primer3_report.md) — surfaced here
 * as a plain fact, not a recommendation either way. */
export default function EngineSelect({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Engine:</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DesignEngine)}
        title="primer3: the real primer3 C library (default). native: thermo-core's Rust engine — faster, ranks candidates differently."
        className="rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border"
      >
        <option value="primer3">primer3</option>
        <option value="native">native (fast)</option>
      </select>
    </div>
  );
}
