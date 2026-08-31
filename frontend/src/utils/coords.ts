/** Converts the wire-format oligo-position tuples the axum routes return
 * (see `api/design.ts`'s module docs for which route uses which
 * convention) into a plain `[start, end)` interval.
 *
 * The legacy app re-derived this arithmetic inline at three separate
 * results-table call sites (`s = coords[0] - coords[1] + 1 + offset`) —
 * collapsed into one function here. */
export function rawTupleToInterval(tuple: [number, number], isRight: boolean): [number, number] {
  const [a, length] = tuple;
  if (isRight) {
    // a is right_end; start = right_end - length + 1, end = right_end + 1.
    return [a - length + 1, a + 1];
  }
  // a is start; end = start + length.
  return [a, a + length];
}

/** The normalized `[start, length]` form (`design_flanking`'s `position`,
 * `design_junction`'s `position`) is the same regardless of strand. */
export function normalizedTupleToInterval(tuple: [number, number]): [number, number] {
  const [start, length] = tuple;
  return [start, start + length];
}
