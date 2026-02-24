---
title: "Primerool: Project Features & Workflow"
author: "Mgr. Vojtěch Rejtar"
date: "2026-02-24"
---

# Primerool: Project Overview

**Author:** Mgr. Vojtěch Rejtar
**Date:** February 24, 2026
**Project:** Primerool

Primerool is a cloud-based, local web application that allows molecular biologists to search for genes, visualise their genomic structure, and design PCR primers directly from the browser, fetching live data from Ensembl and NCBI.

---

## Features and Capabilities

1. **Gene Search & Sequence Retrieval**
   - Live querying of Ensembl or NCBI by gene name (e.g., *BRCA1*) or accession ID.
   - Retrieves all annotated transcripts, canonical transcript auto-selection, full genomic DNA, spliced mRNA, UTRs, and configurable flanking regions.

2. **Multi-Organism Support**
   - Support for 6 kingdoms (Animals, Plants, Bacteria, Fungi, Protists, Viruses) and over 40 pre-configured species.
   - Custom Ensembl species identifier support.

3. **Dual Data Source**
   - Ensembl REST API natively supported.
   - NCBI E-Utilities as a robust, native fallback.

4. **BLAST Integration**
   - FASTA mode to run NCBI BLAST sequence searches.
   - Auto-fills the gene search with the matched organism and gene from top hits.

5. **Interactive Sequence Visualisation**
   - **Feature Map:** Zoomable timeline showing exons, introns, CDS, and UTRs.
   - **Sequence Map:** Full nucleotide sequence with colour-coded annotations, primer binding site highlights, and interactive navigation between features.

6. **Four Primer Design Modes**
   - **WGA (Whole-Genome Amplification):** Primers in flanking regions for amplifying the entire locus.
   - **Internal (Exon-Exon Junction):** Splice-spanning primers for qRT-PCR.
   - **Design from Sequence (Manual):** Targeting specific user-provided forward and reverse regions.
   - **Automatic Pairing:** Configurable conditions (Tm, Length, GC%).

7. **Quality Control**
   - Real-time thermodynamic checking for hairpin formation, self-dimer (homodimer), and heterodimer cross-complementarity using Primer3 engine precision.

---

## Typical Workflow

1. **Launch the Application**
   - **macOS:** Open the `Primerool.app` bundle to launch the native desktop application.
   - **Windows:** Run `Run_primerool.bat` or `Primerool.exe` to start the application.

2. **Organism and Data Source Selection**
   - Select your target organism and preferred data API (Ensembl or NCBI).

3. **Search for Target Gene**
   - Enter a gene symbol (e.g., *BRCA1*) or use the FASTA mode / BLAST integration to identify a target sequence.
   - Primerool fetches the gene's structure and canonical transcript automatically.

4. **Prepare Sequence for Design**
   - Uncheck or check visual elements like Introns or UTRs based on your needs.
   - Configure the upstream and downstream flanking regions.

5. **Review Genomic Structure**
   - Use the Feature Map to get a high-level view of exon layouts.
   - Scroll through the Sequence Map to analyze specific sequence ranges.

6. **Design Primers**
   - Select a primer design mode (e.g., Exon-Exon Junction for expression profiling, or Manual design).
   - Adjust primer conditions like Tm and GC% if needed.
   - Click "Design Primers" and review the ranked primer pairs alongside their QC stats (hairpins, dimers).
   - Click "Use" on a pair to visually highlight their exact binding sites on the Sequence Map.
