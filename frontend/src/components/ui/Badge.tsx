import type { ReactNode } from 'react';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-muted',
  accent: 'bg-accent-subtle text-accent',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
};

interface Props {
  tone?: Tone;
  className?: string;
  title?: string;
  children: ReactNode;
}

export default function Badge({ tone = 'neutral', className = '', title, children }: Props) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${toneClasses[tone]} ${className}`}>
      {children}
    </span>
  );
}
