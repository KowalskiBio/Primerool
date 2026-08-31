export function fmt(x: number | null | undefined): string {
  return x === null || x === undefined ? '-' : String(x);
}

export function yesNo(x: boolean | undefined): string {
  return x ? 'Yes' : 'No';
}
