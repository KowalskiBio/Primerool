//! SpCas9 guide RNA (sgRNA) design, and the cloning oligos for a chosen
//! guide.
//!
//! Unlike every other `design_*` module, this one does **not** go through
//! `picker`: a guide is not a Tm-matched oligo pick. Its length is fixed
//! by the nuclease (20 nt for SpCas9) and its position is fixed by where
//! the PAM happens to sit, so there is no size/Tm window to scan — only a
//! PAM scan, then filtering and ranking of whatever the scan found. What
//! is shared with the other modes is the QC: each spacer's hairpin and
//! self-dimer come from `analyze::analyze_primer`, so a guide's structure
//! numbers are the same Strider numbers a primer reports (relevant here
//! because a self-structured spacer loads into Cas9 poorly).
//!
//! SpCas9 only, deliberately: `PAM` and `SPACER_LEN` are not parameters.
//! Other nucleases (SaCas9's `NNGRRT`, Cas12a's 5'-side `TTTV` and
//! staggered cut) change the result shape — the PAM moves to the other end
//! of the spacer and the cut is no longer blunt — so they want their own
//! pass over this module rather than a flag here.
//!
//! No off-target search happens here. A picked guide goes through the
//! app's existing BLAST path, as a primer does. That is a genuine
//! limitation and not a stand-in for a mismatch-tolerant genome-wide
//! search: BLAST will miss close-but-mismatched sites, which for a guide
//! are exactly the sites that matter.

use crate::analyze::{analyze_primer, PrimerAnalysis};
use crate::backend::{ThermoBackend, ThermoParams};
use crate::defaults::{CRISPR_GC_HARD, CRISPR_GC_IDEAL, CRISPR_SPACER_LEN, DEFAULT_MAX_HAIRPIN_TM, DEFAULT_MAX_SELF_DIMER_TM};

/// SpCas9's protospacer-adjacent motif, 3' of the protospacer.
const PAM_LEN: usize = 3;

/// SpCas9 cuts bluntly 3 bp 5' of the PAM — between spacer positions 17
/// and 18 of 20.
const CUT_OFFSET_FROM_PAM: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum GuideStrand {
    /// The protospacer reads 5'→3' along the input sequence.
    Plus,
    /// The protospacer is the reverse complement of the input sequence.
    Minus,
}

impl GuideStrand {
    pub fn as_str(self) -> &'static str {
        match self {
            GuideStrand::Plus => "+",
            GuideStrand::Minus => "-",
        }
    }
}

/// Why a candidate guide is worse than a perfect one, in the user's words.
/// Carried per guide rather than folded away into the score, so the panel
/// can say *what* is wrong instead of only how much.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct GuideWarning {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DesignedGuide {
    /// The spacer as DNA, 5'→3' on its own strand — what gets cloned. The
    /// sgRNA itself is this with U for T.
    pub analysis: PrimerAnalysis,
    /// The protospacer's `[start, end)` in input coordinates, on the plus
    /// strand regardless of `strand`.
    pub interval: [i32; 2],
    pub strand: GuideStrand,
    /// `[start, end)` of the PAM in input coordinates, again plus-strand.
    pub pam_interval: [i32; 2],
    /// The PAM as read on the guide's own strand (always `NGG` here).
    pub pam: String,
    /// The blunt cut, as an input coordinate: the nick falls between
    /// `cut_site - 1` and `cut_site`.
    pub cut_site: i32,
    /// Heuristic 0–100 rank (see `score_guide`), not a published
    /// on-target score.
    pub score: f64,
    pub warnings: Vec<GuideWarning>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct GuideOverrides {
    pub gc_min: Option<f64>,
    pub gc_max: Option<f64>,
    pub num_return: Option<i32>,
    /// Keep guides whose spacer carries a `TTTT` run. Off by default: it
    /// terminates U6 transcription, so the guide is usually dead on
    /// arrival. Overridable because the guide may be driven by a
    /// different promoter, or delivered as synthetic RNA.
    pub allow_poly_t: Option<bool>,
}

/// Finds every SpCas9 protospacer in `sequence`, on both strands, ranked
/// best-first. Returns the kept guides and a one-line explanation of what
/// the scan threw away (empty guides + a reason, rather than a bare empty
/// list, is what the other design modes do too).
pub fn design_guides(backend: &dyn ThermoBackend, sequence: &str, thermo: ThermoParams, overrides: GuideOverrides) -> (Vec<DesignedGuide>, String) {
    let seq = clean_seq(sequence);
    let gc_min = overrides.gc_min.unwrap_or(CRISPR_GC_HARD.min_gc);
    let gc_max = overrides.gc_max.unwrap_or(CRISPR_GC_HARD.max_gc);
    let num_return = overrides.num_return.unwrap_or(10).max(0) as usize;
    let allow_poly_t = overrides.allow_poly_t.unwrap_or(false);

    let sites = scan_pam_sites(&seq);
    let found = sites.len();

    let mut rejected_n = 0usize;
    let mut rejected_gc = 0usize;
    let mut rejected_poly_t = 0usize;

    let mut guides: Vec<DesignedGuide> = Vec::new();
    for site in sites {
        let spacer = site.spacer(&seq);

        // An N anywhere in the spacer means the template is unknown
        // there, so neither the match nor the QC means anything.
        if spacer.contains('N') {
            rejected_n += 1;
            continue;
        }
        let gc = gc_percent(&spacer);
        if gc < gc_min || gc > gc_max {
            rejected_gc += 1;
            continue;
        }
        if !allow_poly_t && longest_run(&spacer, 'T') >= 4 {
            rejected_poly_t += 1;
            continue;
        }

        let analysis = analyze_primer(backend, &spacer, thermo);
        let (score, warnings) = score_guide(&analysis, gc);
        guides.push(DesignedGuide {
            analysis,
            interval: [site.spacer_start as i32, (site.spacer_start + CRISPR_SPACER_LEN) as i32],
            strand: site.strand,
            pam_interval: [site.pam_start as i32, (site.pam_start + PAM_LEN) as i32],
            pam: site.pam(&seq),
            cut_site: site.cut_site() as i32,
            score,
            warnings,
        });
    }

    // Best score first; ties broken by position so the order is stable
    // across identical requests rather than left to the sort's whim.
    guides.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.interval[0].cmp(&b.interval[0])));
    guides.truncate(num_return);

    let explain = format!(
        "Found {found} NGG site{} in {} bp; skipped {rejected_gc} on GC%, {rejected_poly_t} on a TTTT run, {rejected_n} overlapping an unknown base (N).",
        if found == 1 { "" } else { "s" },
        seq.len()
    );
    (guides, explain)
}

/// One PAM hit: where the protospacer and its PAM sit on the plus strand.
#[derive(Debug, Clone, Copy)]
struct PamSite {
    spacer_start: usize,
    pam_start: usize,
    strand: GuideStrand,
}

impl PamSite {
    fn spacer(&self, seq: &str) -> String {
        let s = &seq[self.spacer_start..self.spacer_start + CRISPR_SPACER_LEN];
        match self.strand {
            GuideStrand::Plus => s.to_string(),
            GuideStrand::Minus => thermo_core::reverse_complement(s),
        }
    }

    fn pam(&self, seq: &str) -> String {
        let p = &seq[self.pam_start..self.pam_start + PAM_LEN];
        match self.strand {
            GuideStrand::Plus => p.to_string(),
            GuideStrand::Minus => thermo_core::reverse_complement(p),
        }
    }

    /// The blunt cut in plus-strand coordinates. It sits 3 bp from the PAM
    /// *on the guide's own strand*, which lands on opposite sides of the
    /// protospacer for the two strands: inside its PAM-proximal end going
    /// right for a plus guide, and going left for a minus guide (whose PAM
    /// lies to the left on the plus strand).
    fn cut_site(&self) -> usize {
        match self.strand {
            GuideStrand::Plus => self.spacer_start + CRISPR_SPACER_LEN - CUT_OFFSET_FROM_PAM,
            GuideStrand::Minus => self.spacer_start + CUT_OFFSET_FROM_PAM,
        }
    }
}

/// Every `NGG` on the plus strand (protospacer to its left) and every
/// `CCN` (an `NGG` read on the minus strand, protospacer to its right).
fn scan_pam_sites(seq: &str) -> Vec<PamSite> {
    let b = seq.as_bytes();
    let n = b.len();
    let mut sites = Vec::new();
    if n < CRISPR_SPACER_LEN + PAM_LEN {
        return sites;
    }

    for i in 0..n.saturating_sub(PAM_LEN - 1) {
        // Plus strand: ...[20nt spacer][N G G]...
        if b[i + 1] == b'G' && b[i + 2] == b'G' && i >= CRISPR_SPACER_LEN {
            sites.push(PamSite { spacer_start: i - CRISPR_SPACER_LEN, pam_start: i, strand: GuideStrand::Plus });
        }
        // Minus strand: ...[C C N][20nt spacer]... — revcomp(CCN) is NGG,
        // and the protospacer lies 3' of that PAM on the minus strand,
        // which is to the *right* here.
        if b[i] == b'C' && b[i + 1] == b'C' && i + PAM_LEN + CRISPR_SPACER_LEN <= n {
            sites.push(PamSite { spacer_start: i + PAM_LEN, pam_start: i, strand: GuideStrand::Minus });
        }
    }
    sites
}

/// A transparent 0–100 heuristic, **not** a published on-target model
/// (Doench Rule Set 2 and friends are trained regressions over large
/// screens; this is a rule of thumb). It only ranks what the PAM scan
/// already found, and every deduction it makes also shows up as a
/// `GuideWarning`, so a user can see the reasoning and overrule it rather
/// than trust an opaque number.
fn score_guide(analysis: &PrimerAnalysis, gc: f64) -> (f64, Vec<GuideWarning>) {
    let mut score = 100.0;
    let mut warnings = Vec::new();
    let mut warn = |code: &'static str, message: String| warnings.push(GuideWarning { code, message });

    // GC% away from the ideal 40-60 band, 1 point per point of drift.
    let drift = if gc < CRISPR_GC_IDEAL.min_gc {
        CRISPR_GC_IDEAL.min_gc - gc
    } else if gc > CRISPR_GC_IDEAL.max_gc {
        gc - CRISPR_GC_IDEAL.max_gc
    } else {
        0.0
    };
    if drift > 0.0 {
        score -= drift;
        warn("gc", format!("GC {gc:.0}% is outside the ideal {:.0}-{:.0}%.", CRISPR_GC_IDEAL.min_gc, CRISPR_GC_IDEAL.max_gc));
    }

    let seq = &analysis.sequence;

    // A long homopolymer makes for sloppy synthesis and sequencing, and a
    // poly-G run can fold into a G-quadruplex.
    for base in ['A', 'C', 'G', 'T'] {
        let run = longest_run(seq, base);
        if run >= 5 {
            score -= 10.0;
            warn("homopolymer", format!("A run of {run} {base}s."));
            break;
        }
    }

    // Spacer self-structure competes with Cas9 loading and with the
    // scaffold's own fold. Same thresholds the primer modes reject on.
    if let Some(tm) = analysis.hairpin.tm {
        if tm > DEFAULT_MAX_HAIRPIN_TM {
            score -= tm - DEFAULT_MAX_HAIRPIN_TM;
            warn("hairpin", format!("Hairpin melts at {tm:.1} °C."));
        }
    }
    if let Some(tm) = analysis.homodimer.tm {
        if tm > DEFAULT_MAX_SELF_DIMER_TM {
            score -= tm - DEFAULT_MAX_SELF_DIMER_TM;
            warn("self-dimer", format!("Self-dimer melts at {tm:.1} °C."));
        }
    }

    // The PAM-proximal base (position 20) is the one the literature is
    // most consistent about: G there helps, T there hurts.
    match seq.chars().last() {
        Some('G') => score += 3.0,
        Some('T') => {
            score -= 3.0;
            warn("pam_proximal_t", "T at the PAM-proximal position (20) is mildly unfavourable.".to_string());
        }
        _ => {}
    }

    // U6 starts transcription on a G. A spacer that lacks one still works
    // — `cloning_oligos` prepends it — so this is a note, not a penalty.
    if !seq.starts_with('G') {
        warn("no_5prime_g", "Does not start with G; the cloning oligos add one for the U6 promoter.".to_string());
    }

    (score.clamp(0.0, 100.0), warnings)
}

/// A vector's BbsI/BsmBI overhangs for guide cloning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloningVector {
    /// pX330 / pSpCas9(BB), cut with BbsI.
    Px330,
    /// lentiCRISPRv2, cut with BsmBI (Esp3I).
    LentiCrisprV2,
}

impl CloningVector {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().replace(['-', '_', ' ', '(', ')'], "").as_str() {
            "px330" | "pspcas9" | "pspcas9bb" => Some(CloningVector::Px330),
            "lenticrisprv2" | "lenticrispr" => Some(CloningVector::LentiCrisprV2),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CloningVector::Px330 => "pX330",
            CloningVector::LentiCrisprV2 => "lentiCRISPRv2",
        }
    }

    pub fn enzyme(self) -> &'static str {
        match self {
            CloningVector::Px330 => "BbsI",
            CloningVector::LentiCrisprV2 => "BsmBI (Esp3I)",
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CloningOligos {
    pub vector: &'static str,
    pub enzyme: &'static str,
    /// The spacer as cloned: `spacer` with a 5' G prepended when it lacks
    /// one, so it is 21 nt in that case.
    pub cloned_spacer: String,
    /// True when that G was added rather than already there.
    pub added_5prime_g: bool,
    /// 5'-CACC + cloned spacer-3'.
    pub top: String,
    /// 5'-AAAC + revcomp(cloned spacer)-3'.
    pub bottom: String,
}

/// The annealed oligo pair that drops a guide into a BbsI/BsmBI-cut
/// vector.
///
/// Both supported vectors take the same 4-nt overhangs (`CACC` on the top
/// oligo, `AAAC` on the bottom), so the two differ only in which enzyme
/// opens the backbone; `vector` is carried through to make that explicit
/// in the UI. The 5'-G is the U6 promoter's transcription start — the
/// Zhang-lab protocols prepend one when the 20-mer does not already begin
/// with G, which is what `added_5prime_g` reports.
///
/// Overhangs must match the user's actual backbone exactly or the ligation
/// fails, so the UI states the vector and enzyme next to the oligos rather
/// than presenting them as universal.
pub fn cloning_oligos(spacer: &str, vector: CloningVector) -> CloningOligos {
    let spacer = clean_seq(spacer);
    let added_5prime_g = !spacer.starts_with('G');
    let cloned_spacer = if added_5prime_g { format!("G{spacer}") } else { spacer };
    CloningOligos {
        vector: vector.as_str(),
        enzyme: vector.enzyme(),
        top: format!("CACC{cloned_spacer}"),
        bottom: format!("AAAC{}", thermo_core::reverse_complement(&cloned_spacer)),
        cloned_spacer,
        added_5prime_g,
    }
}

fn gc_percent(seq: &str) -> f64 {
    if seq.is_empty() {
        return 0.0;
    }
    let gc = seq.bytes().filter(|b| matches!(b, b'G' | b'C')).count();
    100.0 * gc as f64 / seq.len() as f64
}

/// Longest consecutive run of `base`.
fn longest_run(seq: &str, base: char) -> usize {
    let mut best = 0;
    let mut run = 0;
    for c in seq.chars() {
        if c == base {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

fn clean_seq(s: &str) -> String {
    s.trim().to_uppercase().chars().filter(|c| matches!(c, 'A' | 'C' | 'G' | 'T' | 'N')).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;

    /// A plus-strand guide, hand-built: 20 nt spacer then an NGG.
    #[test]
    fn finds_a_plus_strand_guide_and_places_its_cut() {
        //                   0        1         2
        //                   12345678901234567890 PAM
        let seq = format!("{}{}", "ACCTGAGCAGTCGATCGTAC", "AGG");
        let (guides, explain) = design_guides(&NativeBackend, &seq, ThermoParams::default(), GuideOverrides::default());
        assert_eq!(guides.len(), 1, "explain: {explain}");
        let g = &guides[0];
        assert_eq!(g.analysis.sequence, "ACCTGAGCAGTCGATCGTAC");
        assert_eq!(g.strand, GuideStrand::Plus);
        assert_eq!(g.interval, [0, 20]);
        assert_eq!(g.pam_interval, [20, 23]);
        assert_eq!(g.pam, "AGG");
        // Blunt cut 3 bp 5' of the PAM: between bases 17 and 18.
        assert_eq!(g.cut_site, 17);
    }

    /// The same site written on the other strand must come back as the
    /// reverse complement, with the cut mirrored to the spacer's other end.
    #[test]
    fn finds_a_minus_strand_guide() {
        let seq = format!("{}{}", "CCT", "GTACGATCGACTGCTCAGGT");
        let (guides, explain) = design_guides(&NativeBackend, &seq, ThermoParams::default(), GuideOverrides::default());
        assert_eq!(guides.len(), 1, "explain: {explain}");
        let g = &guides[0];
        assert_eq!(g.strand, GuideStrand::Minus);
        assert_eq!(g.analysis.sequence, thermo_core::reverse_complement("GTACGATCGACTGCTCAGGT"));
        assert_eq!(g.interval, [3, 23]);
        assert_eq!(g.pam_interval, [0, 3]);
        assert_eq!(g.pam, "AGG");
        assert_eq!(g.cut_site, 6);
    }

    /// A spacer that would kill U6 transcription is dropped unless asked
    /// for.
    #[test]
    fn drops_poly_t_spacers_unless_allowed() {
        let seq = format!("{}{}", "ACCTGAGCTTTTGATCGTAC", "AGG");
        let (guides, _) = design_guides(&NativeBackend, &seq, ThermoParams::default(), GuideOverrides::default());
        assert!(guides.is_empty(), "TTTT run should be rejected by default");

        let allowed = GuideOverrides { allow_poly_t: Some(true), ..Default::default() };
        let (guides, _) = design_guides(&NativeBackend, &seq, ThermoParams::default(), allowed);
        assert_eq!(guides.len(), 1);
    }

    #[test]
    fn rejects_spacers_over_an_unknown_base() {
        let seq = format!("{}{}", "ACCTGAGCAGNCGATCGTAC", "AGG");
        let (guides, explain) = design_guides(&NativeBackend, &seq, ThermoParams::default(), GuideOverrides::default());
        assert!(guides.is_empty());
        assert!(explain.contains("1 overlapping an unknown base"), "explain: {explain}");
    }

    #[test]
    fn ranks_better_guides_first() {
        // A long GC-rich stretch yields many overlapping candidates.
        let seq = "GCAGTCAGATCCTAGCGTCGAGCCCCCTCTGAGTCAGGAAACATTTTCAGACCTATGGAAACTACTTCCTGAAAACAACGTTCTGTCCCCCTTGCCGTCCAGTCAGATCCTAGCGTCGAGCC";
        let (guides, explain) = design_guides(&NativeBackend, seq, ThermoParams::default(), GuideOverrides::default());
        assert!(guides.len() > 1, "explain: {explain}");
        for w in guides.windows(2) {
            assert!(w[0].score >= w[1].score, "guides must be sorted best-first");
        }
        for g in &guides {
            assert_eq!(g.analysis.length, CRISPR_SPACER_LEN);
            assert!(g.score > 0.0);
        }
    }

    #[test]
    fn num_return_caps_the_list() {
        let seq = "GCAGTCAGATCCTAGCGTCGAGCCCCCTCTGAGTCAGGAAACATTTTCAGACCTATGGAAACTACTTCCTGAAAACAACGTTCTGTCCCCCTTGCCGTCCAGTCAGATCCTAGCGTCGAGCC";
        let overrides = GuideOverrides { num_return: Some(2), ..Default::default() };
        let (guides, _) = design_guides(&NativeBackend, seq, ThermoParams::default(), overrides);
        assert_eq!(guides.len(), 2);
    }

    #[test]
    fn a_sequence_too_short_for_a_protospacer_yields_nothing() {
        let (guides, _) = design_guides(&NativeBackend, "ACGTAGG", ThermoParams::default(), GuideOverrides::default());
        assert!(guides.is_empty());
    }

    #[test]
    fn cloning_oligos_keep_an_existing_5prime_g() {
        let o = cloning_oligos("GCCTGAGCAGTCGATCGTAC", CloningVector::Px330);
        assert!(!o.added_5prime_g);
        assert_eq!(o.cloned_spacer, "GCCTGAGCAGTCGATCGTAC");
        assert_eq!(o.top, "CACCGCCTGAGCAGTCGATCGTAC");
        // The bottom oligo is the top's core, reverse complemented, so the
        // annealed duplex carries both overhangs.
        assert_eq!(o.bottom, format!("AAAC{}", thermo_core::reverse_complement("GCCTGAGCAGTCGATCGTAC")));
        assert!(o.bottom.ends_with('C'), "revcomp of a G-initial spacer ends in C");
        assert_eq!(o.enzyme, "BbsI");
    }

    #[test]
    fn cloning_oligos_add_a_g_when_the_spacer_lacks_one() {
        let o = cloning_oligos("ACCTGAGCAGTCGATCGTAC", CloningVector::LentiCrisprV2);
        assert!(o.added_5prime_g);
        assert_eq!(o.cloned_spacer, "GACCTGAGCAGTCGATCGTAC");
        assert_eq!(o.top, "CACCGACCTGAGCAGTCGATCGTAC");
        assert_eq!(o.bottom, format!("AAAC{}", thermo_core::reverse_complement("GACCTGAGCAGTCGATCGTAC")));
        assert_eq!(o.enzyme, "BsmBI (Esp3I)");
    }

    #[test]
    fn vector_names_parse_loosely() {
        assert_eq!(CloningVector::parse("px330"), Some(CloningVector::Px330));
        assert_eq!(CloningVector::parse("pSpCas9(BB)"), Some(CloningVector::Px330));
        assert_eq!(CloningVector::parse("lentiCRISPRv2"), Some(CloningVector::LentiCrisprV2));
        assert_eq!(CloningVector::parse("pU6"), None);
    }
}
