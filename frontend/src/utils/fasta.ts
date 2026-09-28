import { cleanDNA } from './dna';

/** A GenBank sequence line: a base-position number, then bases in groups
 * (`        61 ttctctgttt attgcacaat ...`). */
const NUMBERED_LINE = /^(\d+)(\s+[A-Za-z]+)+$/;

/** Splits pasted sequence text into `{id, seq}` records — client-side
 * only, same "clean, don't trust the paste" spirit as the rest of this
 * app's sequence inputs. Accepts, mixed freely:
 *
 * - FASTA: a `>` header, then sequence lines (position numbers and spaces
 *   in them are dropped);
 * - GenBank flat files (`LOCUS` … `ORIGIN` … `//`, one or more): only the
 *   bases after `ORIGIN` are read, named by `VERSION` (else the LOCUS name);
 * - a GenBank sequence block on its own (numbered lines, optionally under
 *   `ORIGIN`): consecutive numbered lines are one sequence - a new one
 *   starts when the numbering restarts at 1 (even right after a FASTA
 *   record's bases) or after a blank line;
 * - anything else: one bare sequence per line (`seq1`, `seq2`, …). */
export function parseMultiFasta(text: string): { id: string; seq: string }[] {
  const records: { id: string; seq: string }[] = [];
  let anonCount = 0;
  const nextAnon = () => `seq${++anonCount}`;

  /** The record being read, and what kind of lines are feeding it. */
  let cur: { id: string; seq: string; kind: 'fasta' | 'genbank-header' | 'genbank-seq' | 'numbered' } | null = null;
  const flush = () => {
    if (cur && cur.seq) records.push({ id: cur.id, seq: cleanDNA(cur.seq) });
    cur = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      // A blank line ends a header-less numbered block; FASTA and GenBank
      // records carry on past blank lines.
      if (cur?.kind === 'numbered') flush();
      continue;
    }
    if (line.startsWith('>')) {
      flush();
      cur = { id: line.slice(1).trim() || nextAnon(), seq: '', kind: 'fasta' };
      continue;
    }
    if (/^LOCUS\s/.test(line)) {
      flush();
      cur = { id: line.split(/\s+/)[1] || nextAnon(), seq: '', kind: 'genbank-header' };
      continue;
    }
    if (line === '//') {
      flush();
      continue;
    }
    if (cur?.kind === 'genbank-header') {
      const version = /^VERSION\s+(\S+)/.exec(line);
      if (version) cur.id = version[1];
      if (/^ORIGIN\b/.test(line)) cur.kind = 'genbank-seq';
      continue; // FEATURES, REFERENCE, ... - never sequence
    }
    if (/^ORIGIN\b/.test(line)) {
      // A sequence block pasted from its ORIGIN line on, without the header.
      flush();
      cur = { id: nextAnon(), seq: '', kind: 'numbered' };
      continue;
    }

    const numbered = NUMBERED_LINE.exec(line);
    // Numbering back at 1 after bases were read starts a new sequence -
    // also inside a FASTA record, so a numbered block pasted after one
    // isn't glued onto it. (A GenBank record's own ORIGIN runs to `//`.)
    const restarts = numbered?.[1] === '1' && !!cur?.seq && cur.kind !== 'genbank-seq';
    if (numbered && (restarts || (cur?.kind !== 'fasta' && cur?.kind !== 'genbank-seq'))) {
      // Header-less GenBank block, or a fresh one after other input.
      if (restarts || (cur && cur.kind !== 'numbered')) flush();
      cur ??= { id: nextAnon(), seq: '', kind: 'numbered' };
      cur.seq += line;
      continue;
    }

    if (cur && cur.kind !== 'numbered') {
      cur.seq += line;
    } else {
      // No header and no numbering - each such line is its own sequence.
      flush();
      records.push({ id: nextAnon(), seq: cleanDNA(line) });
    }
  }
  flush();

  return records.filter((r) => r.seq.length > 0);
}
