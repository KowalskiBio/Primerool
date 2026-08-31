import { cleanDNA } from './dna';

/** Splits pasted multi-FASTA text into `{id, seq}` records — client-side
 * only, same "clean, don't trust the paste" spirit as the rest of this
 * app's sequence inputs. A record with no `>` header at all is treated as
 * a single unnamed sequence (`seq1`), matching how a user might paste a
 * bare sequence per line without headers. */
export function parseMultiFasta(text: string): { id: string; seq: string }[] {
  const records: { id: string; seq: string }[] = [];
  let currentId: string | null = null;
  let currentSeq = '';
  let anonCount = 0;

  const flush = () => {
    if (currentId !== null && currentSeq) {
      records.push({ id: currentId, seq: cleanDNA(currentSeq) });
    }
    currentSeq = '';
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      flush();
      currentId = line.slice(1).trim() || `seq${++anonCount}`;
    } else if (currentId !== null) {
      currentSeq += line;
    } else {
      // No header seen yet — treat each such line as its own sequence.
      anonCount += 1;
      records.push({ id: `seq${anonCount}`, seq: cleanDNA(line) });
    }
  }
  flush();

  return records.filter((r) => r.seq.length > 0);
}
