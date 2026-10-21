# Pair design across two windows + per-oligo coverage

Status: resolved
Blocked by: 03

- `/design_conserved` accepts column-based `left_cols`/`right_cols`. The server converts them to consensus offsets and filters pairs to the windows.
- Every designed oligo reports `matching_rows/total_rows` and 3′-end mismatch rows; the results table shows them.
- Unit-test the column→consensus mapping with gap columns, and the coverage counts.

## Comments

Implemented on 2026-10-21 (branch `cusseq`).
