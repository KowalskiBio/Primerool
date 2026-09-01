/** Parse a dot-bracket secondary-structure string into 0-based base pairs
 * `[i, j]` (i < j). Unbalanced input yields whatever pairs did close
 * successfully — callers render "as far as it makes sense", they don't
 * need a hard parse failure for a display-only helper. */
export function parseDotBracketPairs(structure: string): Array<[number, number]> {
  const stack: number[] = [];
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < structure.length; i++) {
    const ch = structure[i];
    if (ch === '(') {
      stack.push(i);
    } else if (ch === ')') {
      const open = stack.pop();
      if (open !== undefined) pairs.push([open, i]);
    }
  }
  return pairs;
}
