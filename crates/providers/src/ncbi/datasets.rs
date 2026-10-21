//! Homolog collection through NCBI Datasets (v2 REST API) - the
//! alternative to `NcbiProvider::collect_homologs`'s GenBank-protein route.
//!
//! Two routes, tried in order:
//! - **Orthologs** (NCBI Orthologs, mostly eukaryotes): a seed gene of the
//!   symbol within the taxon (one E-utilities `esearch` - Datasets' own
//!   symbol lookup wants a species, not a higher taxon), its ortholog
//!   group filtered to the taxon (one gene per species), each gene's
//!   Select transcript CDS from its product report, and all CDSs in one
//!   batched `efetch`.
//! - **Reference assemblies** (prokaryotes, which NCBI Orthologs and most
//!   of NCBI Gene don't cover): the taxon's reference genomes, one per
//!   species, each searched for the gene in its annotation report until
//!   enough species are found; the gene's range is fetched as sequence.
//!
//! Datasets has its own rate limit (5 req/s keyless, 10 with a key), paced
//! here separately from E-utilities'.

use std::time::{Duration, Instant};

use indexmap::IndexMap;
use serde_json::Value;

use super::{Homolog, NcbiProvider, EUTILS, REQUEST_API_KEY};
use crate::{revcomp, ProviderError};

const DATASETS: &str = "https://api.ncbi.nlm.nih.gov/datasets/v2";
/// Datasets' limits are 5 req/s keyless and 10 with a key.
const INTERVAL_KEYLESS: Duration = Duration::from_millis(210);
const INTERVAL_KEYED: Duration = Duration::from_millis(105);
/// Gene ids per `product_report` request.
const PRODUCT_BATCH: usize = 50;
/// Reference assemblies listed per taxon, and searched at most.
const MAX_ASSEMBLIES: usize = 2000;
const MAX_ASSEMBLY_LOOKUPS: usize = 400;

/// Which Datasets route found the homologs.
pub const VIA_ORTHOLOGS: &str = "orthologs";
pub const VIA_ASSEMBLIES: &str = "reference assemblies";

impl NcbiProvider {
    /// A Datasets GET returning JSON, with the request's NCBI key sent as
    /// the `api-key` header. A 404 is "nothing here" (`Value::Null`).
    async fn datasets_json(&self, path: &str, params: &[(&str, &str)]) -> Result<Value, ProviderError> {
        let api_key = REQUEST_API_KEY.try_with(|k| k.clone()).ok().flatten();
        let interval = if api_key.is_some() { INTERVAL_KEYED } else { INTERVAL_KEYLESS };
        let mut retries = 0;
        loop {
            {
                let mut last = self.datasets_last_request.lock().await;
                let elapsed = last.elapsed();
                if elapsed < interval {
                    tokio::time::sleep(interval - elapsed).await;
                }
                *last = Instant::now();
            }
            let mut req = self.client.get(format!("{DATASETS}{path}")).query(params).timeout(Duration::from_secs(60));
            if let Some(key) = &api_key {
                req = req.header("api-key", key);
            }
            let resp = req.send().await?;
            let status = resp.status().as_u16();
            if status == 429 && retries < 2 {
                retries += 1;
                tokio::time::sleep(Duration::from_secs(retries)).await;
                continue;
            }
            if status == 404 {
                return Ok(Value::Null);
            }
            if status >= 400 {
                let message = resp.text().await.unwrap_or_default();
                return Err(ProviderError::UpstreamStatus { status, message });
            }
            return resp.json::<Value>().await.map_err(Into::into);
        }
    }

    /// A taxon name ("Pseudomonas", "Mammalia") or ID to its taxonomy ID.
    async fn datasets_taxid(&self, taxon: &str) -> Result<Option<u64>, ProviderError> {
        let encoded = taxon.trim().replace(' ', "%20");
        let v = self.datasets_json(&format!("/taxonomy/taxon/{encoded}"), &[]).await?;
        Ok(v["taxonomy_nodes"][0]["taxonomy"]["tax_id"].as_u64())
    }

    /// One CDS of `gene` per species within `taxon`, through NCBI Datasets
    /// (see the module docs), and which route found them.
    pub async fn collect_homologs_datasets(&self, gene: &str, taxon: &str, organism_term: &str, max_species: usize) -> Result<(Vec<Homolog>, &'static str), ProviderError> {
        let Some(taxid) = self.datasets_taxid(taxon).await? else {
            return Err(ProviderError::Failed(format!("NCBI Taxonomy doesn't know the taxon '{taxon}'.")));
        };
        let orthologs = self.homologs_via_orthologs(gene, organism_term, taxid, max_species).await?;
        if orthologs.len() >= 2 {
            return Ok((orthologs, VIA_ORTHOLOGS));
        }
        Ok((self.homologs_via_assemblies(gene, taxid, max_species).await?, VIA_ASSEMBLIES))
    }

    async fn homologs_via_orthologs(&self, gene: &str, organism_term: &str, taxid: u64, max_species: usize) -> Result<Vec<Homolog>, ProviderError> {
        let seeds = self.esearch_ids("gene", &format!("{gene}[sym] AND {organism_term}"), 1).await?;
        let Some(seed) = seeds.first() else { return Ok(Vec::new()) };
        let taxid = taxid.to_string();
        let page = max_species.to_string();
        let orthologs = self.datasets_json(&format!("/gene/id/{seed}/orthologs"), &[("taxon_filter", &taxid), ("page_size", &page)]).await?;
        let genes: Vec<(String, String)> = orthologs["reports"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| Some((r["gene"]["gene_id"].as_str()?.to_string(), r["gene"]["taxname"].as_str()?.to_string())))
            .take(max_species)
            .collect();
        if genes.len() < 2 {
            return Ok(Vec::new());
        }

        // Each gene's Select transcript (else a curated NM_, else any
        // transcript) with a single-span CDS on it.
        let mut picks: Vec<OrthologCds> = Vec::new();
        for chunk in genes.chunks(PRODUCT_BATCH) {
            let ids: Vec<&str> = chunk.iter().map(|(id, _)| id.as_str()).collect();
            let products = self.datasets_json(&format!("/gene/id/{}/product_report", ids.join(",")), &[]).await?;
            for r in products["reports"].as_array().into_iter().flatten() {
                if let Some(pick) = pick_ortholog_cds(&r["product"]) {
                    picks.push(pick);
                }
            }
        }

        // All CDSs in one batched efetch, keyed by their mRNA accession.
        let mut cds_by_mrna: IndexMap<String, String> = IndexMap::new();
        for chunk in picks.chunks(100) {
            let ids: Vec<&str> = chunk.iter().map(|p| p.mrna.as_str()).collect();
            let resp = self.get(&format!("{EUTILS}/efetch.fcgi"), &[("db", "nuccore"), ("id", &ids.join(",")), ("rettype", "fasta_cds_na"), ("retmode", "text")], Duration::from_secs(120)).await?;
            cds_by_mrna.extend(parse_cds_fasta(&resp.text().await?));
        }

        // Keep the ortholog report's species order (closest first).
        let order: IndexMap<&str, usize> = genes.iter().enumerate().map(|(i, (id, _))| (id.as_str(), i)).collect();
        picks.sort_by_key(|p| order.get(p.gene_id.as_str()).copied().unwrap_or(usize::MAX));
        Ok(picks
            .into_iter()
            .filter_map(|p| {
                let sequence = cds_by_mrna.get(&p.mrna)?.clone();
                Some(Homolog {
                    species: p.taxname.clone(),
                    isolate: false,
                    organism: p.taxname,
                    strain: None,
                    gene: p.symbol,
                    protein: p.protein,
                    accession: p.mrna,
                    start: p.start,
                    end: p.end,
                    minus_strand: false,
                    sequence,
                })
            })
            .collect())
    }

    async fn homologs_via_assemblies(&self, gene: &str, taxid: u64, max_species: usize) -> Result<Vec<Homolog>, ProviderError> {
        // The taxon's reference genomes, one per species: named species
        // first, then "sp." isolates, each in the report's order.
        let mut assemblies: Vec<Assembly> = Vec::new();
        let mut token = String::new();
        while assemblies.len() < MAX_ASSEMBLIES {
            let mut params = vec![("filters.reference_only", "true"), ("page_size", "1000")];
            if !token.is_empty() {
                params.push(("page_token", token.as_str()));
            }
            let page = self.datasets_json(&format!("/genome/taxon/{taxid}/dataset_report"), &params).await?;
            for r in page["reports"].as_array().into_iter().flatten() {
                let (Some(accession), Some(organism)) = (r["accession"].as_str(), r["organism"]["organism_name"].as_str()) else { continue };
                let strain = r["organism"]["infraspecific_names"]["strain"].as_str().map(str::to_string);
                assemblies.push(Assembly { accession: accession.to_string(), organism: organism.to_string(), strain });
            }
            match page["next_page_token"].as_str() {
                Some(t) if !t.is_empty() => token = t.to_string(),
                _ => break,
            }
        }
        let species = one_per_species(assemblies);

        let mut homologs = Vec::new();
        for (sp, isolate, asm) in species.into_iter().take(MAX_ASSEMBLY_LOOKUPS) {
            if homologs.len() >= max_species {
                break;
            }
            let report = self.datasets_json(&format!("/genome/accession/{}/annotation_report", asm.accession), &[("search_text", gene), ("page_size", "20")]).await?;
            let Some(hit) = report["reports"].as_array().into_iter().flatten().map(|r| &r["annotation"]).find(|a| a["symbol"].as_str().is_some_and(|s| s.eq_ignore_ascii_case(gene))) else {
                continue;
            };
            let region = &hit["genomic_regions"][0]["gene_range"];
            let range = &region["range"][0];
            let (Some(contig), Some(start), Some(end)) = (region["accession_version"].as_str(), num(&range["begin"]), num(&range["end"])) else { continue };
            let minus = range["orientation"].as_str() == Some("minus");
            let Some(mut seq) = self.fetch_region_sequence(contig, contig, start, end).await? else { continue };
            if minus {
                seq = revcomp(&seq);
            }
            homologs.push(Homolog {
                species: sp,
                isolate,
                organism: asm.organism,
                strain: asm.strain,
                gene: hit["symbol"].as_str().unwrap_or(gene).to_string(),
                protein: hit["proteins"][0]["accession_version"].as_str().map_or_else(|| format!("{contig}:{start}-{end}"), str::to_string),
                accession: contig.to_string(),
                start,
                end,
                minus_strand: minus,
                sequence: seq.to_uppercase(),
            });
        }
        Ok(homologs)
    }
}

/// Datasets reports coordinates as strings ("578394").
fn num(v: &Value) -> Option<u64> {
    v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64())
}

#[derive(Debug, Clone, PartialEq)]
struct OrthologCds {
    gene_id: String,
    symbol: String,
    taxname: String,
    mrna: String,
    protein: String,
    start: u64,
    end: u64,
}

/// A gene's CDS for the alignment: on its MANE/RefSeq Select transcript,
/// else the first curated (NM_) one, else the first with a CDS - always a
/// single plus-strand span on the mRNA.
fn pick_ortholog_cds(product: &Value) -> Option<OrthologCds> {
    let transcripts: Vec<&Value> = product["transcripts"].as_array()?.iter().filter(|t| t["cds"]["range"].as_array().is_some_and(|r| r.len() == 1)).collect();
    let rank = |t: &Value| match (t["select_category"].as_str(), t["accession_version"].as_str().unwrap_or_default().starts_with("NM_")) {
        (Some("MANE_SELECT"), _) => 0,
        (Some(_), _) => 1,
        (None, true) => 2,
        (None, false) => 3,
    };
    let t = transcripts.into_iter().min_by_key(|t| rank(t))?;
    let range = &t["cds"]["range"][0];
    Some(OrthologCds {
        gene_id: product["gene_id"].as_str()?.to_string(),
        symbol: product["symbol"].as_str().unwrap_or_default().to_string(),
        taxname: product["taxname"].as_str().unwrap_or_default().to_string(),
        mrna: t["cds"]["accession_version"].as_str().or(t["accession_version"].as_str())?.to_string(),
        protein: t["protein"]["accession_version"].as_str().unwrap_or_default().to_string(),
        start: num(&range["begin"])?,
        end: num(&range["end"])?,
    })
}

/// `efetch rettype=fasta_cds_na` output to `mRNA accession -> CDS`, from
/// headers like `>lcl|NM_000207.3_cds_NP_000198.1_1 [gene=INS] …` (the
/// first CDS of each mRNA).
fn parse_cds_fasta(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for record in text.split('>').skip(1) {
        let (header, body) = record.split_once('\n').unwrap_or((record, ""));
        let Some(id) = header.split_whitespace().next().and_then(|h| h.strip_prefix("lcl|")) else { continue };
        let Some((mrna, _)) = id.split_once("_cds_") else { continue };
        if out.iter().any(|(m, _)| m == mrna) {
            continue;
        }
        out.push((mrna.to_string(), body.split_whitespace().collect::<String>().to_uppercase()));
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
struct Assembly {
    accession: String,
    organism: String,
    strain: Option<String>,
}

/// One assembly per species ("Genus species"), named species before "sp."
/// isolates (each keeping its full name), both in input order.
fn one_per_species(assemblies: Vec<Assembly>) -> Vec<(String, bool, Assembly)> {
    let mut named: IndexMap<String, Assembly> = IndexMap::new();
    let mut isolates: IndexMap<String, Assembly> = IndexMap::new();
    for a in assemblies {
        let words: Vec<&str> = a.organism.split_whitespace().collect();
        if words.len() < 2 {
            continue;
        }
        if matches!(words[1], "sp." | "cf." | "bacterium") {
            isolates.entry(a.organism.clone()).or_insert(a);
        } else {
            named.entry(format!("{} {}", words[0], words[1])).or_insert(a);
        }
    }
    named.into_iter().map(|(s, a)| (s, false, a)).chain(isolates.into_iter().map(|(s, a)| (s, true, a))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_the_select_transcript_cds() {
        let product = json!({
            "gene_id": "3630", "symbol": "INS", "taxname": "Homo sapiens",
            "transcripts": [
                { "accession_version": "XM_1.1", "cds": { "accession_version": "XM_1.1", "range": [{ "begin": "1", "end": "90" }] } },
                { "accession_version": "NM_000207.3", "select_category": "MANE_SELECT", "protein": { "accession_version": "NP_000198.1" },
                  "cds": { "accession_version": "NM_000207.3", "range": [{ "begin": "60", "end": "392", "orientation": "plus" }] } }
            ]
        });
        let p = pick_ortholog_cds(&product).unwrap();
        assert_eq!((p.mrna.as_str(), p.protein.as_str(), p.start, p.end), ("NM_000207.3", "NP_000198.1", 60, 392));
    }

    #[test]
    fn reads_batched_cds_fasta() {
        let text = ">lcl|NM_000207.3_cds_NP_000198.1_1 [gene=INS]\nATGGCC\nCTGTGG\n>lcl|NM_008386.4_cds_NP_032412.3_1 [gene=Ins1]\natgg\n";
        assert_eq!(parse_cds_fasta(text), vec![("NM_000207.3".into(), "ATGGCCCTGTGG".into()), ("NM_008386.4".into(), "ATGG".into())]);
    }

    #[test]
    fn keeps_one_assembly_per_species_isolates_last() {
        let a = |acc: &str, org: &str| Assembly { accession: acc.into(), organism: org.into(), strain: None };
        let picked = one_per_species(vec![a("1", "Pseudomonas sp. X"), a("2", "Pseudomonas putida KT2440"), a("3", "Pseudomonas putida NBRC"), a("4", "Pseudomonas stutzeri A1501")]);
        let names: Vec<(&str, bool, &str)> = picked.iter().map(|(s, i, a)| (s.as_str(), *i, a.accession.as_str())).collect();
        assert_eq!(names, vec![("Pseudomonas putida", false, "2"), ("Pseudomonas stutzeri", false, "4"), ("Pseudomonas sp. X", true, "1")]);
    }
}
