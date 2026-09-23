import type { SelectHTMLAttributes } from 'react';
import { controlClasses } from './TextInput';

interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'sm' | 'md';
}

export default function Select({ size = 'md', className = '', children, ...rest }: Props) {
  return (
    <select
      className={`${controlClasses} cursor-pointer ${size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9'} ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
