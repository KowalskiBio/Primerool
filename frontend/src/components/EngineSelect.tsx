import type { DesignEngine } from '../api/design';
import SegmentedControl from './ui/SegmentedControl';

interface Props {
  value: DesignEngine;
  onChange: (engine: DesignEngine) => void;
}

/** Shared calc-engine picker for the design panels - matches Oligool's own
 * per-request `engine: "primer3"|"strider"` toggle, and its naming: Strider
 * is thermo-core's from-scratch Rust engine, the default here (Oligool
 * itself defaults to primer3 instead). ~10x faster than primer3 and
 * Mathews2004-accurate for hairpin/dimer Tm, but ranks candidate primers
 * differently (see crates/engine/native_vs_primer3_report.md) - surfaced
 * here as a plain fact, not a caveat. */
export default function EngineSelect({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-ink-muted">Engine</span>
      <SegmentedControl
        size="sm"
        ariaLabel="Calculation engine"
        value={value}
        onChange={onChange}
        options={[
          { value: 'strider', label: 'Strider (fast)', title: "Strider: thermo-core's Rust engine (default). Faster, ranks candidates differently than primer3." },
          { value: 'primer3', label: 'primer3', title: 'primer3: the real primer3 C library.' },
        ]}
      />
    </div>
  );
}
