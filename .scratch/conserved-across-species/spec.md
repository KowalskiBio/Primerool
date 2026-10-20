# Conserved primers across species

Status: resolved

## Goal

A student task: "find a conserved stretch of nirS across *Pseudomonas* and design primers in it". Today the Alignments card can already align (MAFFT) and design in a conserved column range. Students still have to:

1. find and paste one sequence per species themselves, and
2. pick the conserved columns by eye.

This feature removes both steps. The flow becomes: load gene → **Collect homologs** (gene + taxon) → tick species → align → see the conservation track and a list of conserved windows → design primers in them.

Steps 3 and 4 of the original proposal (a per-primer × per-species mismatch table, and degenerate primers) are out of scope here. One piece of step 3 is included because the result can't be trusted without it: a "covers N/N sequences" figure on each designed primer.

## What we learned (live NCBI, 2026-10-21)

- **NCBI Gene is too sparse.** `nirS[sym] AND txid286[orgn]` returns 24 records, mostly *P. aeruginosa* strains, and nothing for *P. fluorescens*.
- **GenBank proteins are the rich source.** `nirS[gene] AND txid286[orgn] NOT srcdb_refseq[prop]` returns 1565 protein records. All but one of the first 100 carry a plain `/coded_by` location, so the existing `parse_coded_by_cds` handles them. **But about 90% are *P. aeruginosa*,** so taking the first N gives one species. Collection must pick **one protein per species**, choosing from cheap `esummary` docsums (organism/taxid) before fetching GenPept for the chosen few.
- **Identical Protein Groups (db=ipg) is not useful.** It returns 12 groups, and 20,000 rows of the report are *P. aeruginosa*.
- **NCBI is slow without an API key.** GenPept for 100 proteins took about 90 s, and BLAST timed out twice. Collection therefore runs as a **background job polled by the browser**, like `/blast_batch` (`BlastJobStore`), so it can't hit nginx's ~60 s proxy timeout.
- **CDS lengths vary.** nirS spans 1542–1707 bp across species, so MAFFT will open gaps at the ends. Conservation must treat a gap as "not conserved".

## Design

### Backend

- **`POST /collect_homologs` `{gene, taxon, max_species}`** → `{job_id}`; **`GET /collect_homologs_status/:id`** → `running | done{homologs} | error`. `taxon` is a name or taxid and goes through `ncbi_organism_term`.
- **The job** (in `NcbiProvider`):
  1. `esearch` protein ids (usehistory, cap ~2000).
  2. `esummary` in batches → organism + taxid per id.
  3. Group by species name: the first two words, with "sp. X" isolates kept separate but listed after named species.
  4. Take the first protein of each group, up to `max_species` (default 25).
  5. `efetch rettype=gp` for just those proteins → `parse_coded_by_cds`. If a protein has no plain location, try that species' next protein.
  6. Fetch each CDS sequence (per-region `efetch`, reusing `fetch_region_sequence`, revcomp for minus strand).
- **Result:** `{organism, strain, protein, accession, start, end, strand, length, sequence}` per species, sorted named species first.
- **Wiring:** reuse the `BlastJobStore` pattern rather than duplicate it. Generalise it into a small job store keyed by job type, or give homologs their own instance of the same struct.

### Frontend (Alignments card)

- A **"Collect homologs"** block at the top of `AlignmentPanel`:
  - **Inputs:** a gene field (prefilled with the loaded gene) and a taxon field. The taxon is prefilled with the loaded organism's genus, e.g. `Pseudomonas`, and also takes a taxid.
  - **Run:** a Collect button with a progress note.
  - **Result:** a checklist (species, strain, accession, length). All ticked by default, with a "loaded gene" row pinned first when a gene is loaded.
  - **Hand-off:** "Add to alignment" writes the ticked records into the existing FASTA box (`>Pseudomonas veronii nirS CP…`), so everything after that is the existing align flow, and students can still edit or add sequences.
- **Conservation track** (`AlignmentView`): a full-width bar strip above the rows. Each column's height is the share of rows matching that column's consensus, counting gaps as mismatches. Drawn from `analyzeAlignment`, extended with a per-column `identity` fraction.
- **Conserved windows list:** runs of columns at or above an identity threshold (default 100%, slider down to 80%) of at least 18 columns, sorted by length.
  - Each row shows columns, length and minimum identity.
  - **Single design:** clicking a window fills `colStart`/`colEnd` and runs the existing single-primer design.
  - **Pair design:** ticking two windows and choosing "Design pair" designs a forward primer in the first window and a reverse primer in the second.

### Pair design across two windows

- Today's pair design takes the target in consensus coordinates, and the consensus drops gap-majority columns, so the frontend can't easily compute them. Add **column-based** `left_cols: [a,b)`, `right_cols: [c,d)` to `/design_conserved`.
- The server converts these to consensus offsets and keeps only pairs whose left primer lies inside the left window and right primer inside the right window. In `engine::conserved`, reuse `design_pairs_in_conserved_region` over `[a, d)` with the gap between windows as the target, then filter.

### Coverage on every designed oligo

- `engine::conserved` maps each candidate back to its alignment columns and counts the rows whose bases differ from the oligo, overall and within the 3′-terminal 5 nt.
- It returns `{matching_rows, total_rows, three_prime_mismatch_rows}`. The results table shows "covers 18/20 (2 with 3′ mismatches)".

## Verification

- Unit tests:
  - species grouping/selection from a docsum fixture dominated by one species;
  - column→consensus conversion with gap columns;
  - window detection on a hand-made alignment;
  - coverage counts.
- A live `#[ignore]` test: collecting nirS in `286` yields ≥10 distinct species, each CDS starting with a start codon.
- In the app:
  1. load nirS (*P. fluorescens*);
  2. Collect homologs in *Pseudomonas* and add them to the alignment;
  3. align and confirm the track shows conserved windows;
  4. design a pair across two windows and check it covers all or most species.
- Commit by path, push, deploy (AGENTS.md).
