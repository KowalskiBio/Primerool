import type { InputHTMLAttributes, ReactNode } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
}

export default function Checkbox({ label, className = '', id, ...rest }: Props) {
  return (
    <label htmlFor={id} className={`inline-flex cursor-pointer select-none items-center gap-2 text-sm text-ink ${className}`}>
      <input type="checkbox" id={id} className="h-4 w-4 cursor-pointer accent-accent" {...rest} />
      {label}
    </label>
  );
}
