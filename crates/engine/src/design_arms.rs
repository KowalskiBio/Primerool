//! ARMS-PCR (Amplification Refractory Mutation System) allele-specific
//! primer design — new algorithmic surface, no Python original (see the
//! primer-mode-revamp plan). Classic 2-reaction layout only (not
//! tetra-primer/single-tube), per the locked-in product decision.
//!
//! **Scope for this pass**: the allele-specific primer is always the LEFT
//! primer, its 3'-most base landing exactly on the last base of the
//! allele (plus strand); the shared common primer is always a RIGHT primer
//! picked downstream via `picker::pick_oligos`. The mirror-image orientation
//! (allele-specific RIGHT primer, common LEFT primer) is out of scope for
//! this pass, matching `design_junction`'s own precedent of scoping itself
//! to one orientation.
//!
//! Closest prior art is `design_junction`: one side is hand-built
//! (candidate windows enumerated and scored directly) while the other side
//! is picked from every downstream window,
//! then the two are paired by Tm/product-size compatibility. Here the
//! hand-built side's sequence is additionally constrained to end on a
//! specific allele base, and — unlike junction mode — is shared by two
//! independent pairings (ref+common, alt+common) against the *same*
//! searched pool, so the common primer is searched once and filtered
//! against both alleles at once.

use crate::analyze::{analyze_pair, analyze_primer, PairAnalysis, PrimerAnalysis};
use crate::backend::{ThermoBackend, ThermoParams};
use crate::picker::{in_region, pick_oligos, scan_candidates, Candidate, CandidateConstraints, GcRange, OligoFilters, PenaltyWeights, SizeRange, Strand, TmRange};
use crate::defaults::{
    default_destabilizing_substitution, ARMS_MAX_TM_DIFF, ARMS_PRIMER_GC, ARMS_PRIMER_TM, DEFAULT_PRIMER_SIZE,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Allele {
    Ref,
    Alt,
}

/// 0-based, VCF-anchor style: `pos` is where `ref_allele` begins in the
/// template. `ref_allele`/`alt_allele` may differ in length (small indels
/// are supported, not just single-base SNPs) but neither may be empty — a
/// clean insertion/deletion where one allele has zero length has no base
/// at the variant position to anchor a discriminating 3' end for that
/// allele, which is out of scope for classic ARMS-PCR as implemented here.
#[derive(Debug, Clone, PartialEq)]
pub struct VariantSite {
    pub pos: usize,
    pub ref_allele: String,
    pub alt_allele: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArmsParams {
    pub mismatch_enabled: bool,
    /// Bases in from the 3' end where a deliberate destabilizing mismatch
    /// is introduced, standard ARMS-PCR practice for extra specificity.
    pub mismatch_offset: usize,
    /// `None` = auto-pick via `default_destabilizing_substitution`.
    pub mismatch_base: Option<char>,
    /// How far past the variant to search for the common primer.
    pub common_pad: i32,
    pub product_min: i32,
    pub product_max: i32,
    pub max_common_candidates: usize,
}

impl Default for ArmsParams {
    fn default() -> Self {
        use crate::defaults::*;
        Self {
            mismatch_enabled: true,
            mismatch_offset: ARMS_DEFAULT_MISMATCH_OFFSET as usize,
            mismatch_base: None,
            common_pad: ARMS_DEFAULT_COMMON_PAD as i32,
            product_min: ARMS_DEFAULT_PRODUCT_MIN as i32,
            product_max: ARMS_DEFAULT_PRODUCT_MAX as i32,
            max_common_candidates: ARMS_DEFAULT_MAX_COMMON_CANDIDATES as usize,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArmsAlleleSpecificPrimer {
    pub allele: Allele,
    pub analysis: PrimerAnalysis,
    /// `[start, end)` into the (uppercased) input `template`.
    pub interval: [i32; 2],
    /// 0-based index into this primer's own sequence, for UI display —
    /// `None` when no mismatch was applied (disabled, or would have landed
    /// inside the discriminating allele base(s) and was skipped).
    pub mismatch_position: Option<i32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArmsCommonCandidate {
    pub analysis: PrimerAnalysis,
    pub interval: [i32; 2],
    pub product_size_ref: i32,
    pub product_size_alt: i32,
    pub pair_metrics_ref: PairAnalysis,
    pub pair_metrics_alt: PairAnalysis,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArmsDesignResult {
    pub ref_primer: ArmsAlleleSpecificPrimer,
    pub alt_primer: ArmsAlleleSpecificPrimer,
    /// Best-first. The common primer is the one thing genuinely worth
    /// offering choices over — both allele-specific sequences are
    /// essentially fixed by the allele.
    pub common_candidates: Vec<ArmsCommonCandidate>,
}

#[derive(Debug, thiserror::Error)]
pub enum ArmsError {
    #[error("Empty template")]
    EmptyTemplate,
    #[error("ref_allele and alt_allele must both be non-empty")]
    EmptyAllele,
    #[error("variant position out of range")]
    VariantPosOutOfRange,
    #[error("template at the variant position does not match the supplied ref allele (expected {expected}, found {found})")]
    RefAlleleMismatch { expected: String, found: String },
    #[error("could not build a valid-length allele-specific primer window")]
    NoValidPrimerWindow,
    #[error("no common primers found downstream of the variant. {0}")]
    NoCommonPrimersFound(String),
}

fn build_allele_primer(
    backend: &dyn ThermoBackend,
    template: &str,
    variant: &VariantSite,
    allele: Allele,
    params: &ArmsParams,
    thermo: ThermoParams,
) -> Result<ArmsAlleleSpecificPrimer, ArmsError> {
    let allele_seq: &str = match allele {
        Allele::Ref => &variant.ref_allele,
        Allele::Alt => &variant.alt_allele,
    };

    let substituted = format!("{}{}{}", &template[..variant.pos], allele_seq, &template[variant.pos + variant.ref_allele.len()..]);
    let three_prime_idx = variant.pos + allele_seq.len() - 1;

    let primer_min = DEFAULT_PRIMER_SIZE.min_size as usize;
    let primer_max = DEFAULT_PRIMER_SIZE.max_size as usize;
    let opt_tm = ARMS_PRIMER_TM.opt_tm;

    let mut best: Option<(f64, usize, usize, PrimerAnalysis)> = None; // (score, start, len, analysis)
    for len in primer_min..=primer_max {
        if len > three_prime_idx + 1 {
            continue;
        }
        let start = three_prime_idx + 1 - len;
        let end = three_prime_idx + 1;
        if end > substituted.len() {
            continue;
        }
        let window = &substituted[start..end];
        let a = analyze_primer(backend, window, thermo);
        let tm = a.tm.unwrap_or(0.0);
        let gc = a.gc_percent.unwrap_or(0.0);
        let mut score = (tm - opt_tm).abs();
        if !(ARMS_PRIMER_GC.min_gc..=ARMS_PRIMER_GC.max_gc).contains(&gc) {
            score += 5.0;
        }
        if best.as_ref().map(|(best_score, ..)| score < *best_score).unwrap_or(true) {
            best = Some((score, start, len, a));
        }
    }

    let (_, start, len, _pre_mismatch_analysis) = best.ok_or(ArmsError::NoValidPrimerWindow)?;
    let end = start + len;
    let mut seq_bytes = substituted[start..end].as_bytes().to_vec();

    let allele_start = variant.pos;
    let allele_end = variant.pos + allele_seq.len();
    let mut mismatch_position: Option<i32> = None;
    if params.mismatch_enabled && params.mismatch_offset < len {
        let local_idx = len - 1 - params.mismatch_offset;
        let abs_idx = start + local_idx;
        if abs_idx < allele_start || abs_idx >= allele_end {
            let original = seq_bytes[local_idx] as char;
            let sub = params.mismatch_base.unwrap_or_else(|| default_destabilizing_substitution(original));
            seq_bytes[local_idx] = sub.to_ascii_uppercase() as u8;
            mismatch_position = Some(local_idx as i32);
        }
    }

    let final_seq = String::from_utf8(seq_bytes).expect("template is ASCII DNA");
    let analysis = analyze_primer(backend, &final_seq, thermo);

    Ok(ArmsAlleleSpecificPrimer { allele, analysis, interval: [start as i32, end as i32], mismatch_position })
}

/// How many downstream common-primer candidates are picked before the
/// allele-Tm compatibility filter.
const COMMON_POOL: usize = 30;

pub fn design_arms_primers(
    backend: &dyn ThermoBackend,
    template: &str,
    variant: &VariantSite,
    params: &ArmsParams,
    thermo: ThermoParams,
) -> Result<ArmsDesignResult, ArmsError> {
    let template = template.to_uppercase().replace(' ', "");
    if template.is_empty() {
        return Err(ArmsError::EmptyTemplate);
    }
    let ref_allele = variant.ref_allele.to_uppercase();
    let alt_allele = variant.alt_allele.to_uppercase();
    if ref_allele.is_empty() || alt_allele.is_empty() {
        return Err(ArmsError::EmptyAllele);
    }
    if variant.pos >= template.len() || variant.pos + ref_allele.len() > template.len() {
        return Err(ArmsError::VariantPosOutOfRange);
    }
    let found = &template[variant.pos..variant.pos + ref_allele.len()];
    if found != ref_allele {
        return Err(ArmsError::RefAlleleMismatch { expected: ref_allele, found: found.to_string() });
    }

    let variant = VariantSite { pos: variant.pos, ref_allele, alt_allele };

    let ref_primer = build_allele_primer(backend, &template, &variant, Allele::Ref, params, thermo)?;
    let alt_primer = build_allele_primer(backend, &template, &variant, Allele::Alt, params, thermo)?;

    let allele_max_len = variant.ref_allele.len().max(variant.alt_allele.len());
    let common_region_start = variant.pos + allele_max_len;
    if common_region_start >= template.len() {
        return Err(ArmsError::NoCommonPrimersFound("no sequence downstream of the variant".into()));
    }
    let common_region_len = (params.common_pad.max(0) as usize).min(template.len() - common_region_start);
    let primer_min = DEFAULT_PRIMER_SIZE.min_size as usize;
    if common_region_len < primer_min {
        return Err(ArmsError::NoCommonPrimersFound("window too small for a common primer".into()));
    }

    // Only windows that give an in-range product with *both* allele
    // primers are worth picking from.
    let common_region_end = common_region_start + common_region_len;
    let product_ok = |c: &Candidate| {
        let ok = |left_start: i32| (params.product_min..=params.product_max).contains(&(c.end as i32 - left_start));
        ok(ref_primer.interval[0]) && ok(alt_primer.interval[0])
    };
    // The common primer has to pair with both allele primers, so its Tm
    // window is centred on theirs (within `ARMS_MAX_TM_DIFF` of each, and
    // inside the ARMS bounds) rather than on the generic optimum.
    let ref_tm = ref_primer.analysis.tm.unwrap_or(ARMS_PRIMER_TM.opt_tm);
    let alt_tm = alt_primer.analysis.tm.unwrap_or(ARMS_PRIMER_TM.opt_tm);
    let tm_min = ARMS_PRIMER_TM.min_tm.max(ref_tm.max(alt_tm) - ARMS_MAX_TM_DIFF);
    let tm_max = ARMS_PRIMER_TM.max_tm.min(ref_tm.min(alt_tm) + ARMS_MAX_TM_DIFF);
    let tm_opt = ((ref_tm + alt_tm) / 2.0).clamp(tm_min.min(tm_max), tm_max.max(tm_min));
    let constraints = CandidateConstraints {
        size: SizeRange { min: primer_min, opt: DEFAULT_PRIMER_SIZE.opt_size as usize, max: DEFAULT_PRIMER_SIZE.max_size as usize },
        tm: TmRange { min: tm_min, opt: tm_opt, max: tm_max },
        gc: GcRange { min: ARMS_PRIMER_GC.min_gc, max: ARMS_PRIMER_GC.max_gc },
    };
    let pool: Vec<Candidate> = in_region(&scan_candidates(&template, &constraints), common_region_start, common_region_end).into_iter().filter(product_ok).collect();
    let picked = pick_oligos(backend, &template, &pool, Strand::Reverse, &constraints, &OligoFilters::default(), thermo, &PenaltyWeights::default(), COMMON_POOL);

    if picked.oligos.is_empty() {
        return Err(ArmsError::NoCommonPrimersFound(picked.explain()));
    }

    let mut scored: Vec<(f64, ArmsCommonCandidate)> = Vec::new();
    for rc in &picked.oligos {
        let rc_end = rc.candidate.end as i32;
        let product_size_ref = rc_end - ref_primer.interval[0];
        let product_size_alt = rc_end - alt_primer.interval[0];
        if (rc.tm - ref_tm).abs() > ARMS_MAX_TM_DIFF || (rc.tm - alt_tm).abs() > ARMS_MAX_TM_DIFF {
            continue;
        }

        let right_a = analyze_primer(backend, &rc.sequence, thermo);
        let pair_metrics_ref = analyze_pair(backend, &ref_primer.analysis.sequence, &rc.sequence, thermo);
        let pair_metrics_alt = analyze_pair(backend, &alt_primer.analysis.sequence, &rc.sequence, thermo);
        let score = rc.penalty;

        scored.push((
            score,
            ArmsCommonCandidate {
                analysis: right_a,
                interval: [rc.candidate.start as i32, rc_end],
                product_size_ref,
                product_size_alt,
                pair_metrics_ref,
                pair_metrics_alt,
            },
        ));
    }

    if scored.is_empty() {
        return Err(ArmsError::NoCommonPrimersFound(
            "no candidate satisfied the product-size/Tm-compatibility constraints for both alleles".into(),
        ));
    }
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    scored.truncate(params.max_common_candidates.max(1));
    let common_candidates = scored.into_iter().map(|(_, c)| c).collect();

    Ok(ArmsDesignResult { ref_primer, alt_primer, common_candidates })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_native::NativeBackend;

    // A realistic-length synthetic template with the variant well clear of
    // both ends so a full-length primer window and downstream common-primer
    // region both fit.
    fn template() -> String {
        "ACGTGACCTGATCGATCGGATCGTAGCTAGCATGCA".repeat(20)
    }

    #[test]
    fn finds_allele_specific_and_common_primers_around_a_realistic_snp() {
        let backend = NativeBackend;
        let t = template();
        let pos = 200;
        let variant = VariantSite { pos, ref_allele: t[pos..pos + 1].to_string(), alt_allele: "G".to_string() };
        // Pick an alt base that actually differs from ref.
        let variant = if variant.ref_allele == variant.alt_allele {
            VariantSite { alt_allele: "C".to_string(), ..variant }
        } else {
            variant
        };

        let result = design_arms_primers(&backend, &t, &variant, &ArmsParams::default(), ThermoParams::default()).unwrap();

        assert_eq!(result.ref_primer.analysis.sequence.chars().last().unwrap().to_string(), variant.ref_allele);
        assert_eq!(result.alt_primer.analysis.sequence.chars().last().unwrap().to_string(), variant.alt_allele);
        assert_eq!(result.ref_primer.interval[1] as usize, pos + 1);
        assert_eq!(result.alt_primer.interval[1] as usize, pos + 1);
        assert!(!result.common_candidates.is_empty());
        for c in &result.common_candidates {
            assert!(c.interval[0] as usize > pos);
        }
    }

    #[test]
    fn rejects_ref_allele_mismatch() {
        let backend = NativeBackend;
        let t = template();
        let pos = 200;
        // Deliberately wrong ref base.
        let wrong_ref = if &t[pos..pos + 1] == "A" { "T" } else { "A" };
        let variant = VariantSite { pos, ref_allele: wrong_ref.to_string(), alt_allele: "G".to_string() };
        let result = design_arms_primers(&backend, &t, &variant, &ArmsParams::default(), ThermoParams::default());
        assert!(matches!(result, Err(ArmsError::RefAlleleMismatch { .. })));
    }

    #[test]
    fn mismatch_position_lands_inside_primer_and_not_on_the_allele_base() {
        let backend = NativeBackend;
        let t = template();
        let pos = 200;
        let ref_base = t[pos..pos + 1].to_string();
        let alt_base = if ref_base == "A" { "G" } else { "A" }.to_string();
        let variant = VariantSite { pos, ref_allele: ref_base, alt_allele: alt_base };

        let params = ArmsParams { mismatch_enabled: true, mismatch_offset: 3, ..ArmsParams::default() };
        let result = design_arms_primers(&backend, &t, &variant, &params, ThermoParams::default()).unwrap();

        for primer in [&result.ref_primer, &result.alt_primer] {
            let mp = primer.mismatch_position.expect("mismatch should have been applied");
            let len = primer.analysis.sequence.len() as i32;
            assert_eq!(mp, len - 1 - 3);
            assert!(mp < len - 1, "mismatch must not land on the 3'-terminal discriminating base");
        }
    }
}
