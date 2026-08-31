//! MAFFT subprocess wrapper, ported from Oligool's `backend/alignment.py`
//! (Phase 7).
//!
//! Contract stays a raw aligned-FASTA string passthrough — no server-side
//! parsing. Mismatch/insertion/anchor-column detection is entirely
//! client-side in the frontend (ported from Oligool's `anchorGrid.ts`/
//! `msa.ts`), matching Oligool's design exactly.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum AlignError {
    #[error("mafft binary not found on PATH or in bundled sidecar location")]
    BinaryNotFound,
    #[error("mafft exited with an error: {0}")]
    ExecutionFailed(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq)]
pub struct SequenceInput {
    pub id: String,
    pub seq: String,
}

fn clean_seq(seq: &str) -> String {
    seq.trim().replace(' ', "").to_uppercase()
}

/// Resolves the `mafft` executable: system `PATH` first (via the `which`
/// crate, mirroring `shutil.which` in the Python original), then a handful
/// of bundled-sidecar-relative locations next to the current executable —
/// the same resolution chain as Oligool's `alignment.py::run_msa`.
///
/// **No bundled binary actually ships in this repo yet** — Tauri
/// `externalBin` packaging (registering a real per-platform MAFFT binary as
/// a sidecar) is a distribution/CI task, not something a source checkout
/// can provide. The bundled-path checks below are real code, not
/// placeholders — they'll pick up a real bundled binary the day the
/// packaging work lands — but today, in every environment this crate is
/// actually exercised in, resolution is expected to succeed via the first
/// (`which`) branch or not at all.
pub fn find_mafft_binary() -> Option<PathBuf> {
    if let Ok(path) = which::which("mafft") {
        return Some(path);
    }

    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = if cfg!(target_os = "windows") {
        exe_dir.join(".bin").join("mafft").join("mafft-win").join("mafft.bat")
    } else if cfg!(target_os = "macos") {
        exe_dir.join(".bin").join("mafft").join("mafft-mac").join("mafft-mac").join("mafftdir").join("bin").join("mafft")
    } else {
        exe_dir.join(".bin").join("mafft").join("mafft-linux").join("bin").join("mafft")
    };
    candidate.exists().then_some(candidate)
}

/// Runs MAFFT on `sequences`, returning the aligned-FASTA text exactly as
/// MAFFT printed it to stdout — no parsing, matching the Python original's
/// contract exactly (the frontend does all interpretation).
///
/// Writes a real temp FASTA file (not stdin — MAFFT expects a file path),
/// runs in a minimal, explicitly-constructed environment (`PATH`, `TMPDIR`,
/// `MAFFT_TMPDIR` pointed at a dedicated scratch directory), and picks
/// `--retree 2` over `--auto` once the input exceeds 100 sequences — all
/// ported directly from `alignment.py::run_msa`'s own comments on *why*
/// (`--auto`'s full progressive-refinement search doesn't scale past
/// ~100 sequences; `--retree 2` is the fast FFT-NS-2 method and still
/// supports multithreading, unlike `--parttree`, whose `splittbfast` helper
/// is single-threaded only).
pub async fn run_msa(sequences: &[SequenceInput]) -> Result<String, AlignError> {
    if sequences.is_empty() {
        return Ok(String::new());
    }

    let mafft = find_mafft_binary().ok_or(AlignError::BinaryNotFound)?;

    let tmp_input = tempfile::Builder::new().suffix(".fasta").tempfile()?;
    {
        let mut file = tokio::fs::File::create(tmp_input.path()).await?;
        let mut buf = String::new();
        for s in sequences {
            buf.push('>');
            buf.push_str(&s.id);
            buf.push('\n');
            buf.push_str(&clean_seq(&s.seq));
            buf.push('\n');
        }
        file.write_all(buf.as_bytes()).await?;
        file.flush().await?;
    }

    // A dedicated, pre-existing scratch directory for this run's own tmp
    // usage — bypasses MAFFT's internal `mktemp`-style calls failing under
    // sandboxing (the exact issue Oligool's own comment describes on
    // macOS), same fix, ported directly.
    let run_dir = tempfile::tempdir()?;

    let num_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).to_string();

    let mut cmd = Command::new(&mafft);
    if sequences.len() > 100 {
        cmd.args(["--retree", "2", "--thread", &num_threads, "--quiet"]);
    } else {
        cmd.args(["--auto", "--thread", &num_threads, "--quiet"]);
    }
    cmd.arg(tmp_input.path());

    // A deliberately minimal environment — avoids user-shell pollution that
    // (per the Python original's own comment) can break e.g. Homebrew's
    // MAFFT wrapper script.
    cmd.env_clear();
    cmd.env("PATH", std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_string()));
    cmd.env("TMPDIR", run_dir.path());
    cmd.env("MAFFT_TMPDIR", run_dir.path());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = cmd.output().await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(AlignError::ExecutionFailed(stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seq(id: &str, s: &str) -> SequenceInput {
        SequenceInput { id: id.to_string(), seq: s.to_string() }
    }

    #[tokio::test]
    async fn run_msa_on_empty_input_returns_empty_string() {
        let result = run_msa(&[]).await.unwrap();
        assert_eq!(result, "");
    }

    /// Real end-to-end run against the actual `mafft` binary (confirmed
    /// present on this system: `mafft --version` -> v7.526) — not mocked.
    /// Three near-identical sequences with a couple of deliberate indels,
    /// checked for the shape real MAFFT output always has: one `>` header
    /// per input record, and every aligned sequence coming back the same
    /// (gapped) length.
    #[tokio::test]
    async fn run_msa_aligns_real_sequences_with_mafft() {
        if find_mafft_binary().is_none() {
            eprintln!("mafft not found on this system; skipping");
            return;
        }
        let sequences = vec![
            seq("seq1", "ACGTACGTACGTACGTACGTACGT"),
            seq("seq2", "ACGTACGTACGACGTACGTACGT"), // one base deleted mid-sequence
            seq("seq3", "ACGTACGTACGTACGTAACGTACGT"), // one base inserted mid-sequence
        ];

        let alignment = run_msa(&sequences).await.expect("mafft run should succeed");

        let headers: Vec<&str> = alignment.lines().filter(|l| l.starts_with('>')).collect();
        assert_eq!(headers.len(), 3, "expected one header per input sequence, got: {alignment}");
        assert!(headers.iter().any(|h| h.contains("seq1")));
        assert!(headers.iter().any(|h| h.contains("seq2")));
        assert!(headers.iter().any(|h| h.contains("seq3")));

        // Reconstruct each aligned sequence (MAFFT wraps sequence lines) and
        // confirm they're all the same (gapped) length, the defining
        // property of a real multiple-sequence alignment.
        let mut lengths = Vec::new();
        let mut current = String::new();
        for line in alignment.lines() {
            if line.starts_with('>') {
                if !current.is_empty() {
                    lengths.push(current.len());
                    current.clear();
                }
            } else {
                current.push_str(line.trim());
            }
        }
        if !current.is_empty() {
            lengths.push(current.len());
        }
        assert_eq!(lengths.len(), 3);
        assert!(lengths.iter().all(|&l| l == lengths[0]), "all aligned sequences must share one length, got {lengths:?}");
        assert!(lengths[0] >= 24, "aligned length should be at least as long as the longest input sequence");
    }
}
