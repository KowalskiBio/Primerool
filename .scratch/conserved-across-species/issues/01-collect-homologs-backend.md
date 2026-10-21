# Collect homologs: backend job

Status: resolved

Spec: `../spec.md` (Backend).

- `NcbiProvider::collect_homologs(gene, taxon_term, max_species)`: esearch protein → esummary batches → one protein per species → gp efetch of the chosen ones → `parse_coded_by_cds` (fall back to the species' next protein) → fetch each CDS sequence.
- `POST /collect_homologs` + `GET /collect_homologs_status/:id` as a background job, same pattern as `/blast_batch`.
- Unit test species selection on a docsum fixture dominated by *P. aeruginosa*. Add a live `#[ignore]` test for nirS in `286` (≥10 species).

## Comments

Implemented on 2026-10-21 (branch `cusseq`).
