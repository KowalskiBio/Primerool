// The SNP batch BLAST check as a downloadable report: a self-contained HTML
// page (summary table, then per pair its off-target amplicons and each
// primer's worst off-target hits with alignments - printable to PDF) and a
// CSV with one row per BLAST hit for filtering in a spreadsheet. Pure
// string builders over the same analysis the dialog shows
// (`primerPairHits.ts` / `primerAlignment.ts`).

import type { BlastHit } from '../api/blast';
import { THREE_PRIME_WINDOW, assessPrimerHit, type PrimerHitAssessment } from './primerAlignment';
import { MAX_PRODUCT_BP, ampliconSites, findSharedTargets, genesAtHit, isGeneHit, rankOffTargetHits, type AmpliconSite, type FlanksOf, type GenesOf, type RankedHit, type SharedTarget, type Target } from './primerPairHits';

/** Off-target hits per primer the HTML report details. */
export const REPORT_TOP_HITS = 5;
/** Ranked candidates per primer whose primer ends are fetched before the
 * final ranking - real end bases can reorder the list, so fetch a margin
 * beyond the hits finally shown. */
const RANK_MARGIN = 15;

export interface ReportPrimer {
  sequence: string;
  status: 'pending' | 'running' | 'done' | 'error';
  hits: BlastHit[];
  error?: string;
  /** Why this primer's BLAST may not match the current design, if so. */
  staleNote?: string;
}

export interface ReportPair {
  /** rsID(s) the pair was designed for. */
  label: string;
  gene: string;
  /** Organism slug the pair was BLASTed against. */
  organism: string;
  /** The gene's other names (see `fetchTargetNames`), when looked up. */
  targetNames?: string[];
  /** Genomic location of the designed amplicon, e.g. "4:176,782,050-176,782,248". */
  location: string;
  designedSize: number | null;
  fwd: ReportPrimer;
  rev: ReportPrimer;
}

export interface ReportMeta {
  /** Organism label the BLAST was restricted to. */
  organism: string;
  generatedAt: Date;
}

interface PairAnalysis {
  targets: SharedTarget[];
  sites: AmpliconSite[];
  /** Shared off-target sequences giving no reasonable product. */
  sharedWithoutProduct: number;
  locus: Set<string>;
  fwdRanked: RankedHit[];
  revRanked: RankedHit[];
}

const bothDone = (p: ReportPair) => p.fwd.status === 'done' && p.rev.status === 'done';
const noGenes: GenesOf = () => undefined;
const targetOf = (p: ReportPair, genesOf: GenesOf): Target => ({ gene: p.gene, names: p.targetNames, genesOf });

function analyzePair(p: ReportPair, flanksOf: FlanksOf, genesOf: GenesOf): PairAnalysis | null {
  if (!bothDone(p)) return null;
  const target = targetOf(p, genesOf);
  const targets = findSharedTargets(p.fwd.sequence, p.fwd.hits, p.rev.sequence, p.rev.hits, target, p.designedSize, flanksOf);
  const off = targets.filter((t) => !t.onTarget);
  const sites = ampliconSites(off, genesOf);
  const inSites = new Set(sites.flatMap((s) => s.records.map((r) => r.accession)));
  const locus = new Set(targets.filter((t) => t.sameSizeAsTarget).map((t) => t.accession));
  return {
    targets,
    sites,
    sharedWithoutProduct: off.filter((t) => !inSites.has(t.accession) && !locus.has(t.accession)).length,
    locus,
    fwdRanked: rankOffTargetHits(p.fwd.sequence, p.fwd.hits, target, locus, flanksOf),
    revRanked: rankOffTargetHits(p.rev.sequence, p.rev.hits, target, locus, flanksOf),
  };
}

/** The hits a report judges, whose genes and unaligned primer ends it
 * needs looked up first: every hit on a sequence both primers hit (where
 * products are judged) and each primer's top-ranked off-target candidates
 * (with a margin - looked-up genes and end bases can reorder them). */
export function hitsNeedingFlanks(pairs: ReportPair[], flanksOf: FlanksOf, genesOf: GenesOf = noGenes): BlastHit[] {
  const out: BlastHit[] = [];
  for (const p of pairs) {
    const a = analyzePair(p, flanksOf, genesOf);
    if (!a) continue;
    for (const t of a.targets) out.push(t.fwd.hit, t.rev.hit);
    for (const r of [...a.fwdRanked.slice(0, RANK_MARGIN), ...a.revRanked.slice(0, RANK_MARGIN)]) out.push(r.hit);
  }
  return out;
}

// --- HTML ---------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const VERDICT_CLASS = { perfect: 'bad', risk: 'bad', weak: 'warn', unlikely: 'ok' } as const;

/** Identical bases over the whole primer, e.g. "18/20". */
function identity(a: PrimerHitAssessment): string {
  const len = Math.max(...a.columns.map((c) => c.qPos));
  return `${a.columns.filter((c) => c.kind === 'match').length}/${len}`;
}

function strand(hit: BlastHit): 'plus' | 'minus' {
  return hit.hit_from > hit.hit_to ? 'minus' : 'plus';
}

/** Three aligned rows as preformatted HTML - the same marks as the app's
 * `PrimerHitAlignment`: mismatches and gaps highlighted, unaligned primer
 * ends dotted, the 3'-terminal window underlined. */
function alignmentHtml(hit: BlastHit, a: PrimerHitAssessment): string {
  const len = Math.max(...a.columns.map((c) => c.qPos));
  const cell = (ch: string, kind: string, qPos: number) => {
    const cls = [kind === 'match' ? '' : kind === 'unaligned' ? 'u' : 'x', qPos > len - THREE_PRIME_WINDOW ? 'w' : ''].filter(Boolean).join(' ');
    return cls ? `<span class="${cls}">${esc(ch)}</span>` : esc(ch);
  };
  const primer = a.columns.map((c) => cell(c.primer, c.kind, c.qPos)).join('');
  const target = a.columns.map((c) => cell(c.target || '·', c.kind, c.qPos)).join('');
  const mid = a.columns.map((c) => (c.kind === 'match' ? '|' : c.kind === 'unaligned' ? ' ' : '×')).join('');
  return `<pre class="aln"><span class="l">Primer 5′ </span>${primer}<span class="l"> 3′</span>
<span class="l">          </span>${esc(mid)}
<span class="l">Target    </span>${target}<span class="l"> ${hit.hit_from.toLocaleString('en-US')}–${hit.hit_to.toLocaleString('en-US')} (${strand(hit)} strand)</span></pre>`;
}

function hitCardHtml(name: string, hit: BlastHit, a: PrimerHitAssessment | null, genesOf: GenesOf, showTitle = true): string {
  const head = a
    ? `<span class="tag ${VERDICT_CLASS[a.level]}">${esc(a.level === 'perfect' ? 'Perfect match' : a.label)}</span> <span class="muted">${esc(a.reason)}</span>`
    : `<span class="tag">no alignment</span>`;
  const stats = `cover ${hit.query_cover}%${a ? ` · id ${identity(a)}` : ''}`;
  const inGene = genesAtHit(hit, genesOf);
  return `<div class="hit"><div class="hh">${name ? `<b>${esc(name)}</b> ` : ''}${head} <a href="https://www.ncbi.nlm.nih.gov/nuccore/${esc(hit.accession)}">${esc(hit.accession)}</a> <span class="stats">${stats}</span>${inGene ? ` <span class="gene">lies in ${esc(inGene)}</span>` : ''}</div>
${showTitle ? `<div class="title">${esc(hit.title)}</div>` : ''}${a ? alignmentHtml(hit, a) : ''}</div>`;
}

function sitesSummaryHtml(a: PairAnalysis | null, p: ReportPair): string {
  if (!a) return `<span class="muted">${esc(p.fwd.status === 'error' || p.rev.status === 'error' ? 'BLAST failed' : 'not BLASTed')}</span>`;
  if (a.sites.length === 0) return '<span class="tag ok">None</span>';
  return a.sites.map((s) => `<span class="tag ${s.mismatched3 ? 'warn' : 'bad'}">${esc(s.label)} · ${s.size.toLocaleString('en-US')} bp${s.mismatched3 ? ' · 3′ mismatch' : ''}</span>`).join(' ');
}

function primerStatusHtml(pr: ReportPrimer): string {
  const notes = [pr.status === 'error' ? `BLAST failed: ${pr.error ?? 'unknown error'}` : pr.status !== 'done' ? 'not BLASTed' : '', pr.staleNote ?? ''].filter(Boolean);
  return notes.map((n) => `<div class="note">${esc(n)}</div>`).join('');
}

function pairSectionHtml(p: ReportPair, a: PairAnalysis | null, i: number, genesOf: GenesOf): string {
  const primers = `<table class="kv">
<tr><th>Forward</th><td class="seq">5′ ${esc(p.fwd.sequence)} 3′</td><td>${p.fwd.sequence.length} nt · ${p.fwd.hits.length} hits${primerStatusHtml(p.fwd)}</td></tr>
<tr><th>Reverse</th><td class="seq">5′ ${esc(p.rev.sequence)} 3′</td><td>${p.rev.sequence.length} nt · ${p.rev.hits.length} hits${primerStatusHtml(p.rev)}</td></tr>
<tr><th>Amplicon</th><td colspan="2">${p.designedSize !== null ? `${p.designedSize.toLocaleString('en-US')} bp` : '-'} · ${esc(p.location)}</td></tr>
</table>`;
  if (!a) return `<section class="pair" id="pair-${i}"><h2>${esc(p.gene)} — ${esc(p.label)}</h2>${primers}<p class="muted">No BLAST results for both primers.</p></section>`;

  const sites = a.sites.length
    ? a.sites
        .map((s) => {
          const r = s.records[0];
          const others = s.records.slice(1).map((o) => `<div class="title">also: ${esc(o.accession)} — ${esc(o.title)}</div>`).join('');
          return `<div class="site"><div class="hh"><span class="tag ${s.mismatched3 ? 'warn' : 'bad'}">${esc(s.label)} · ${s.size.toLocaleString('en-US')} bp</span>${s.mismatched3 ? ' <span class="muted">both primers bind, but a 3′-end mismatch makes a product unlikely</span>' : ''}</div>
<div class="title">${esc(r.accession)} — ${esc(r.title)}</div>${others}
${hitCardHtml('Forward', r.fwd.hit, r.fwd.assessment, genesOf, false)}${hitCardHtml('Reverse', r.rev.hit, r.rev.assessment, genesOf, false)}</div>`;
        })
        .join('')
    : `<p><span class="tag ok">None</span> No sequence other than ${esc(p.gene)} and its locus is bound by both primers on opposite strands, 3′ ends facing, within ${MAX_PRODUCT_BP.toLocaleString('en-US')} bp.</p>`;
  const shared = `<p class="muted">Other sequences both primers hit without a reasonable product: ${a.sharedWithoutProduct}. Records of ${esc(p.gene)} itself or its locus: ${a.targets.filter((t) => t.onTarget || a.locus.has(t.accession)).length}.</p>`;
  const top = (name: string, ranked: RankedHit[]) =>
    `<div class="col"><h4>${name} primer — top ${Math.min(REPORT_TOP_HITS, ranked.length)} of ${ranked.length}</h4>${
      ranked.length ? ranked.slice(0, REPORT_TOP_HITS).map((r) => hitCardHtml('', r.hit, r.assessment, genesOf)).join('') : '<p class="muted">No hits other than the target.</p>'
    }</div>`;

  return `<section class="pair" id="pair-${i}">
<h2>${esc(p.gene)} — ${esc(p.label)}</h2>
${primers}
<h3>Off-target amplicons (both primers)</h3>
${sites}
${shared}
<h3>Top off-target hits per primer</h3>
<p class="muted">Hits other than ${esc(p.gene)} and its locus, most likely to prime first. One primer binding alone makes no product.</p>
<div class="cols">${top('Forward', a.fwdRanked)}${top('Reverse', a.revRanked)}</div>
</section>`;
}

const REPORT_CSS = `
:root { --ink:#1d2433; --muted:#5b6475; --faint:#8a92a3; --line:#dde1e8; --bg:#ffffff; --surface:#f6f7f9; --bad:#b42318; --bad-bg:#fdecea; --warn:#9a5b00; --warn-bg:#fff4e0; --ok:#1e7a3c; --ok-bg:#e6f4ea; --accent:#2457d6; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 0 0 12px; } h3 { font-size: 14px; margin: 20px 0 8px; } h4 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 8px; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
.muted { color: var(--muted); } .note { color: var(--warn); font-size: 12px; }
table { border-collapse: collapse; width: 100%; }
.summary th, .summary td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; font-size: 12px; }
.summary th { background: var(--surface); text-transform: uppercase; font-size: 11px; color: var(--muted); }
.kv th { text-align: left; color: var(--muted); font-weight: 500; padding: 2px 12px 2px 0; width: 90px; vertical-align: top; } .kv td { padding: 2px 12px 2px 0; vertical-align: top; }
.seq, pre, code { font-family: ui-monospace, "IBM Plex Mono", Menlo, Consolas, monospace; }
.gene { font-size: 12px; font-weight: 600; color: var(--ink); }
.tag { display: inline-block; border-radius: 4px; padding: 0 6px; font-size: 12px; font-weight: 600; background: var(--surface); color: var(--muted); white-space: nowrap; }
.tag.bad { background: var(--bad-bg); color: var(--bad); } .tag.warn { background: var(--warn-bg); color: var(--warn); } .tag.ok { background: var(--ok-bg); color: var(--ok); }
.pair { border-top: 2px solid var(--line); padding-top: 24px; margin-top: 32px; }
.site, .hit { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 0 0 8px; break-inside: avoid; }
.site .hit { border: 0; padding: 4px 0 0; margin: 0; }
.hh { font-size: 12px; } .stats { color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; white-space: nowrap; }
.title { color: var(--muted); font-size: 12px; margin: 2px 0; }
pre.aln { margin: 6px 0 0; font-size: 12px; line-height: 1.45; overflow-x: auto; white-space: pre; }
pre.aln .l { color: var(--faint); } pre.aln .x { color: var(--bad); background: var(--bad-bg); font-weight: 700; } pre.aln .u { color: var(--faint); } pre.aln .w { text-decoration: underline; text-decoration-color: var(--accent); text-decoration-thickness: 2px; text-underline-offset: 3px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } .col { min-width: 0; }
.method { margin-top: 40px; border-top: 1px solid var(--line); padding-top: 16px; font-size: 12px; color: var(--muted); }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }
@media print { main { padding: 0; max-width: none; } .pair { break-before: page; border-top: 0; margin-top: 0; } a { color: inherit; } }
`;

export function buildBlastReportHtml(pairs: ReportPair[], meta: ReportMeta, flanksOf: FlanksOf, genesOf: GenesOf = noGenes): string {
  const analyses = pairs.map((p) => analyzePair(p, flanksOf, genesOf));
  const when = meta.generatedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const withSites = analyses.filter((a) => a && a.sites.some((s) => !s.mismatched3)).length;
  const rows = pairs
    .map(
      (p, i) => `<tr><td>${esc(p.gene)}</td><td><a href="#pair-${i}">${esc(p.label)}</a></td><td>${esc(p.location)}</td><td class="seq">${esc(p.fwd.sequence)}</td><td class="seq">${esc(p.rev.sequence)}</td><td>${
        p.designedSize !== null ? `${p.designedSize.toLocaleString('en-US')} bp` : '-'
      }</td><td>${sitesSummaryHtml(analyses[i], p)}${primerStatusHtml(p.fwd)}${primerStatusHtml(p.rev)}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Primer BLAST report</title><style>${REPORT_CSS}</style></head>
<body><main>
<h1>Primer BLAST report</h1>
<p class="muted">Primerool · ${esc(when)} · ${pairs.length} primer pair${pairs.length === 1 ? '' : 's'} · organism: ${esc(meta.organism)} · ${withSites} pair${withSites === 1 ? '' : 's'} with a possible off-target amplicon</p>
<table class="summary"><thead><tr><th>Gene</th><th>rsID(s)</th><th>Amplicon</th><th>Forward 5′→3′</th><th>Reverse 5′→3′</th><th>Product</th><th>Off-target amplicons (both primers)</th></tr></thead>
<tbody>
${rows}
</tbody></table>
${pairs.map((p, i) => pairSectionHtml(p, analyses[i], i, genesOf)).join('\n')}
<div class="method"><b>Method.</b> Each primer was searched with NCBI blastn against the nucleotide collection (nt), restricted to ${esc(meta.organism)}, tuned for short oligos (word size 11, E ≤ 1000, no low-complexity filter), keeping 50 hits per primer. An <b>off-target amplicon</b> is a sequence other than the gene of interest where both primers bind on opposite strands with their 3′ ends facing, at most ${MAX_PRODUCT_BP.toLocaleString('en-US')} bp apart; a product the designed amplicon's size is taken to be the target locus itself (e.g. a BAC clone of it). A hit counts as the gene of interest when its record annotates that gene (under any of its NCBI Gene names) at the hit's position - "lies in" names the annotated gene - or, where nothing is annotated, when the record's title names it. A hit is judged by where it mismatches (Primer-BLAST's default rule): 2 or more mismatches in the 3′-terminal ${THREE_PRIME_WINDOW} nt, or 6 or more in total, is not expected to prime. Primer ends BLAST left unaligned were filled in from the hit's own sequence where it could be fetched (· = not available, counted as a mismatch). Only each primer's best alignment per sequence is known, so a second binding site on the same long sequence would be missed. "cover" is BLAST's query cover; "id" counts identical bases over the whole primer.</div>
</main></body></html>`;
}

// --- CSV ----------------------------------------------------------------

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  'gene', 'rsids', 'amplicon', 'primer', 'primer_sequence', 'blast_rank', 'accession', 'organism', 'gene_symbol', 'title',
  'gene_at_hit', 'category', 'other_primer_hits_it', 'off_target_amplicon_bp', 'verdict', 'reason', 'identity', 'mismatches', 'mismatches_3prime_5nt',
  'query_cover_pct', 'evalue', 'hit_from', 'hit_to', 'strand', 'primer_aligned', 'target_aligned', 'primer_ends_resolved',
] as const;

/** One row per BLAST hit of every primer, with the pair-level context
 * (is it the target, does the other primer hit it, the product there). */
export function buildBlastHitsCsv(pairs: ReportPair[], flanksOf: FlanksOf, genesOf: GenesOf = noGenes): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const p of pairs) {
    const a = analyzePair(p, flanksOf, genesOf);
    const target = targetOf(p, genesOf);
    const productByAcc = new Map<string, number>();
    for (const s of a?.sites ?? []) for (const r of s.records) productByAcc.set(r.accession, s.size);
    for (const [name, pr, other] of [
      ['forward', p.fwd, p.rev],
      ['reverse', p.rev, p.fwd],
    ] as const) {
      if (pr.status !== 'done') continue;
      const otherAcc = new Set(other.hits.map((h) => h.accession));
      pr.hits.forEach((hit, i) => {
        const fl = flanksOf(hit);
        const as = assessPrimerHit(pr.sequence, hit, fl);
        const dangling = hit.query_from > 1 || hit.query_to < hit.query_len;
        const category = isGeneHit(hit, target) ? 'target_gene' : a?.locus.has(hit.accession) ? 'target_locus' : 'off_target';
        // Genes annotated at the hit; "?" = not looked up, "" = none annotated.
        const annotated = genesOf(hit);
        const geneAtHit = annotated === undefined || annotated === null ? '?' : annotated.map((g) => g.symbol).join(';');
        const row = [
          p.gene, p.label, p.location, name, pr.sequence, i + 1, hit.accession, hit.organism, hit.gene_symbol, hit.title,
          geneAtHit, category, otherAcc.has(hit.accession) ? 'yes' : 'no', productByAcc.get(hit.accession) ?? '',
          as ? as.label : '', as ? as.reason : '', as ? identity(as) : '', as ? as.mismatches : '', as ? as.threePrimeMismatches : '',
          hit.query_cover, hit.evalue, hit.hit_from, hit.hit_to, strand(hit),
          as ? as.columns.map((c) => c.primer).join('') : '', as ? as.columns.map((c) => c.target || '.').join('') : '',
          dangling ? (fl && (fl.five || fl.three) ? 'yes' : 'no') : 'n/a',
        ];
        lines.push(row.map(csvCell).join(','));
      });
    }
  }
  // Byte-order mark so Excel reads the file as UTF-8 (5′/3′, en dashes).
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Triggers a browser download of `text` as `filename`. */
export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
