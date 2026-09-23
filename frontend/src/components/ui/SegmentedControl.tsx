import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

interface Props<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  ariaLabel: string;
  className?: string;
}

export default function SegmentedControl<T extends string>({ options, value, onChange, size = 'md', ariaLabel, className = '' }: Props<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5 ${size === 'sm' ? 'text-xs' : 'text-sm'} ${className}`}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.title}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-2.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
            size === 'sm' ? 'h-6' : 'h-7'
          } ${value === opt.value ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
