# Primeroonline

Cloud-based primer design tool for genes, exons, and whole-genome amplification (WGA).

## Capabilities

**1. Gene Search & Sequence Retrieval**
* Search for any human gene (e.g., *BRCA1*) and fetch genomic (with introns) or spliced (exons only) sequences directly from Ensembl.
* Customize flanking regions, UTRs, and introns.

**2. Visual Sequence Map**
* Interactive viewer color-codes exons, introns, UTRs, and CDS.
* Visualizes primer binding sites directly on the sequence.

**3. BLAST Integration**
* Identify unknown sequences using NCBI BLAST directly within the app.
* Returns top hits with organism, gene symbol, and accession.

**4. Primer Design Modes**
* **WGA (Whole Genome Amplification)**: Designs primers in flanking regions to amplify the entire gene body.
* **Internal (Exon-Exon Junctions)**: Designs splice-spanning primers for qRT-PCR to avoid genomic contamination.
* **Design from Sequence**: Design primers from any two custom sequence regions (Forward/Reverse).
* **Manual**: Design primers from custom sequence regions.

**5. Quality Control**
* Automatic checks for hairpins, self-dimers, and heterodimers.
* Uses Primer3 engine for accurate Tm and GC calculations.

## How to Run (Mac)

1.  Find the `Run_primerool.command` file in this folder.
2.  Double-click it.
3.  A terminal window will open, and the app will launch in your default web browser.

## How to Run (Windows)

1.  Find the `Run_primerool.bat` file in this folder.
2.  Double-click it.
3.  A command prompt window will open, and the app will launch in your default web browser.

## How to Run (Development)

1.  Install Python 3.
2.  Create a virtual environment: `python3 -m venv venv`
3.  Activate it: `source venv/bin/activate`
4.  Install dependencies: `pip install -r requirements.txt`
5.  Run the app: `python src/app.py`
6.  Open http://127.0.0.1:5050
