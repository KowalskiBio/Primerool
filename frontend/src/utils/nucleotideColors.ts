/** Shared base coloring/pairing-symbol convention for every structure
 * diagram (`HairpinSvg.tsx`, `DimerSvg.tsx`) - kept in one place so a
 * hairpin and a dimer diagram always read as the same visual language. */

export function basePairSymbol(a: string, b: string): 'wc' | 'wobble' | 'none' {
  const pair = (a + b).toUpperCase();
  const watson = ['AT', 'TA', 'AU', 'UA', 'GC', 'CG'];
  const wobble = ['GT', 'TG', 'GU', 'UG'];
  if (watson.includes(pair)) return 'wc';
  if (wobble.includes(pair)) return 'wobble';
  return 'none';
}

export function baseColor(b: string): string {
  switch (b.toUpperCase()) {
    case 'A':
      return '#dc4b4b'; // red
    case 'T':
    case 'U':
      return '#3f83d8'; // blue
    case 'G':
      return '#d99126'; // amber
    case 'C':
      return '#37a06a'; // green
    default:
      return 'var(--ink-faint)';
  }
}
