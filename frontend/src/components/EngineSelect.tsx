import type { DesignEngine } from '../api/design';

interface Props {
  value: DesignEngine;
  onChange: (engine: DesignEngine) => void;
}

/** Shared calc-engine picker for the design panels — matches Oligool's own
 * per-request `engine: "primer3"|"strider"` toggle, and its naming: Strider
 * is thermo-core's from-scratch Rust engine, the default here (Oligool
 * itself defaults to primer3 instead). ~10x faster than primer3 and
 * Mathews2004-accurate for hairpin/dimer Tm, but ranks candidate primers
 * differently (see crates/engine/native_vs_primer3_report.md) — surfaced
 * here as a plain fact, not a caveat. */
export default function EngineSelect({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Engine:</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DesignEngine)}
        title="Strider: thermo-core's Rust engine (default) — faster, ranks candidates differently than primer3. primer3: the real primer3 C library."
        className="rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border"
      >
        <option value="strider">Strider (fast)</option>
        <option value="primer3">primer3</option>
      </select>
    </div>
  );
}
