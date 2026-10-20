# Conservation track and conserved windows

Status: resolved

- `analyzeAlignment` gains a per-column identity fraction (gaps count as mismatches).
- Bar strip above `AlignmentView` rows.
- Windows list: threshold slider (100% default, down to 80%), minimum 18 columns. Clicking a row fills the column range and runs single-primer design.
- Unit-test window detection.

## Comments

Implemented on 2026-10-21 (branch `cusseq`).
