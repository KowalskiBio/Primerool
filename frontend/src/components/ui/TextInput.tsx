import type { InputHTMLAttributes } from 'react';

/** Shared form-control recipe; also used for textareas and selects. */
export const controlClasses =
  'w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25';

export default function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${controlClasses} h-9 ${className}`} {...rest} />;
}
