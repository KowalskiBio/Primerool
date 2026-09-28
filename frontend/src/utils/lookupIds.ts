/**
 * Resolves the external database IDs a loaded sequence's header wants to
 * link to - the record's own accession (NM_/XM_/ENST), its gene ID
 * (NCBI Gene uid / Ensembl ENSG), and the reference assembly (GCF/GCA or
 * Ensembl's assembly name).
 *
 * Done client-side via the providers' REST APIs rather than extending
 * `/get_sequence`: that route is golden-fixture-locked (exact body
 * equality) and these are display-link conveniences, not analysis data.
 * Both APIs are CORS-open. Results memoize in-module for the session, so
 * navigating between viewers or toggling doesn't refetch.
 */
export interface SequenceIds {
  /** Gene identifier: NCBI Gene uid (e.g. "7157") or Ensembl "ENSG…". */
  geneId: string | null;
  /** Raw assembly accession (e.g. "GCF_000001405.40") or Ensembl's name
   * (e.g. "GRCh38"). */
  assembly: string | null;
}

const cache = new Map<string, SequenceIds>();

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status}`);
  return resp.json();
}

/** NCBI: accession -> Gene uid (+ linked nuccore -> assembly GCF). */
async function resolveNcbi(transcriptId: string, ncbiApiKey: string): Promise<SequenceIds> {
  const keyParam = ncbiApiKey ? `&api_key=${encodeURIComponent(ncbiApiKey)}` : '';
  const base = transcriptId.trim();

  // 1. Gene uid from the transcript accession ([accn] works for
  //    NM_/XM_/NR_/XR_ with or without the version suffix).
  let geneId: string | null = null;
  try {
    const esearch = await fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gene&term=${encodeURIComponent(base)}%5Baccn%5D&retmode=json${keyParam}`);
    geneId = esearch?.esearchresult?.idlist?.[0] ?? null;
  } catch {
    geneId = null;
  }

  // 2. Assembly: accession -> nuccore uid -> (drop version) -> assembly
  //    uid -> GCF accession. Any step failing just yields no assembly.
  let assembly: string | null = null;
  try {
    const nSearch = await fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=nuccore&term=${encodeURIComponent(base)}%5Baccn%5D&retmode=json${keyParam}`);
    const uid: string | undefined = nSearch?.esearchresult?.idlist?.[0];
    if (uid) {
      const nSumm = await fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=nuccore&id=${uid}&retmode=json${keyParam}`);
      const accver: string | undefined = nSumm?.result?.[uid]?.accessionversion;
      const chrAcc = accver?.split('.')[0];
      if (chrAcc) {
        const aSearch = await fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=assembly&term=${encodeURIComponent(chrAcc)}&retmode=json&retmax=5${keyParam}`);
        const uidA: string | undefined = aSearch?.esearchresult?.idlist?.[0];
        if (uidA) {
          const aSumm = await fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=assembly&id=${uidA}&retmode=json${keyParam}`);
          assembly = aSumm?.result?.[uidA]?.assemblyaccession ?? null;
        }
      }
    }
  } catch {
    assembly = null;
  }

  return { geneId, assembly };
}

/** Ensembl: transcript lookup -> Parent (ENSG) + assembly_name. */
async function resolveEnsembl(transcriptId: string): Promise<SequenceIds> {
  const id = transcriptId.trim().split('.')[0];
  try {
    const d = await fetchJson(`https://rest.ensembl.org/lookup/id/${encodeURIComponent(id)}?content-type=application/json`);
    return { geneId: d?.Parent ?? null, assembly: d?.assembly_name ?? null };
  } catch {
    return { geneId: null, assembly: null };
  }
}

/** Cached per (source, transcript). `api_source` is optional because some
 * viewers render custom sequences with no provider at all - those pass an
 * empty string and short-circuit to nothing. */
export async function resolveSequenceIds(apiSource: 'ensembl' | 'ncbi' | '', transcriptId: string, ncbiApiKey: string): Promise<SequenceIds> {
  if (!transcriptId || apiSource === '') return { geneId: null, assembly: null };
  const cacheKey = `${apiSource}:${transcriptId}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const ids = apiSource === 'ncbi' ? await resolveNcbi(transcriptId, ncbiApiKey) : await resolveEnsembl(transcriptId);
  cache.set(cacheKey, ids);
  return ids;
}
