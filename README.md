# 🧬 Primerool

**Cloud-based primer design tool for any organism.**

Primerool is a local web application that lets you search for genes, visualise their genomic structure, and design PCR primers — all from your browser. It fetches data live from **Ensembl** and **NCBI**, so no local genome files are needed. Just run it and start designing.

---

## What Can It Do?

### 1. Gene Search & Sequence Retrieval

Search for any gene by **name** (e.g. *BRCA1*, *AP1*, *mcrA*) or **accession ID** (e.g. *NM_105581.3*). Primerool queries Ensembl or NCBI in real time and returns:

- All annotated transcripts with exon count and strand info
- The canonical transcript is auto-selected
- Genomic DNA (full span with introns) or spliced mRNA (exons only)
- Optional UTR inclusion
- Configurable upstream and downstream flanking regions

### 2. Multi-Organism Support

Primerool is not limited to humans. Pick from **6 kingdoms** and **40+ pre-configured species**, or enter any Ensembl-compatible species name:

| Kingdom | Example Species |
|---|---|
| **Animals** | Human, Mouse, Rat, Zebrafish, Chicken, Pig, Cow, Dog, Cat, Sheep, Rabbit, Macaque, Chimpanzee, Frog, Fruit Fly, *C. elegans* |
| **Plants** | *Arabidopsis thaliana*, Rice, Maize, Wheat, Tomato, Soybean, Grape, Potato, Barley, Tobacco |
| **Bacteria** | *E. coli* K-12, *B. subtilis* 168, *S. aureus*, *P. aeruginosa*, *M. tuberculosis*, *S. enterica*, *S. pneumoniae* |
| **Fungi** | *S. cerevisiae*, *S. pombe*, *A. nidulans*, *N. crassa*, *C. albicans* |
| **Protists** | *P. falciparum*, *T. brucei*, *L. major*, *D. discoideum*, *T. gondii* |
| **Viruses** | SARS-CoV-2 |

Every kingdom also offers a **Custom** option where you can type in any Ensembl species identifier.

### 3. Dual Data Source

Choose between two independent APIs:

- **Ensembl REST API** — the default, covers all domains of life
- **NCBI E-Utilities** — robust fallback; especially useful when Ensembl is slow or unreachable (happens way too often)

Both produce the same downstream output (transcripts, exons, sequences, flanking regions).

### 4. BLAST Integration

If you prefer, you can switch to **FASTA mode**, paste a sequence (or accession ID), and Primerool runs an **NCBI BLAST** search. It returns the top hits with:

- Organism name
- Gene symbol
- Accession and identity %
- A **"Use this"** button that auto-fills the gene search with the matched organism and gene

### 5. Interactive Sequence Visualisation

Once a sequence is loaded, Primerool enabels user to use two interactive views:

- **Feature Map** — a zoomable timeline showing exons, introns, CDS, and UTRs as coloured blocks. Primer binding sites are overlaid when designed.
- **Sequence Map** — the full nucleotide sequence with colour-coded annotations:
  - Flanking regions (grey)
  - UTRs (yellow)
  - CDS (orange, bold)
  - Introns (italic, truncated to show length only when in truncated mode)
  - Primer binding sites (red highlights)

Click any exon in the Feature Map to jump to it in the Sequence Map.

### 6. Four Primer Design Modes

#### WGA (Whole-Genome Amplification)
Designs primer pairs in the **flanking regions** (upstream + downstream) to amplify the entire gene locus. Uses Primer3 with configurable settings.

#### Internal (Exon–Exon Junction)
Designs **splice-spanning primers** that cross exon–exon junctions. Ideal for **qRT-PCR** — ensures that only cDNA (not genomic DNA) is amplified.

#### Design from Sequence (Manual)
Paste any two sequence regions — one for forward, one for reverse — and Primer3 picks the best primers from each. Includes a collapsible **⚙️ Primer Conditions** panel to customise:

| Parameter | Default |
|---|---|
| Melting Temperature (Tm) | 57 / 62 / 67 °C (min / opt / max) |
| Primer Length | 18 / 20 / 25 bp (min / opt / max) |
| GC Content | 40 – 60 % |
| Max Primers to Return | 5 |

#### Automatic Pairing
All modes return ranked primer pairs with:
- Per-primer stats (Tm, GC%, length)
- Hairpin and self-dimer analysis (ΔG)
- Heterodimer analysis for each pair
- A **"Use"** button to highlight the binding site on the sequence map

### 7. Quality Control

Every designed primer is automatically checked for:

- **Hairpin formation** — structure found? ΔG value
- **Self-dimer (homodimer)** — structure found? ΔG value
- **Heterodimer** — cross-complementarity between forward and reverse primers
- **Tm accuracy** — calculated using nearest-neighbour thermodynamics (Primer3 engine)

---

## Getting Started

### macOS

1. Navigate to the `dist/` folder and double-click the **`Primerool.app`** bundle.
2. It will instantly launch as a native PyInstaller desktop application with a custom dock icon.

**Building for macOS (.app / .dmg):**
To compile the standalone OS X application yourself:
1. Run the automated packager:
   ```bash
   ./scripts/build_mac.sh
   ```
2. This will generate the **`Primerool.app`** bundle and **`Primerool.dmg`** installer in the `dist/` directory.

**Building for Windows (.exe):**
To generate a standalone Windows executable, you must run the build on a Windows machine:
1. Run the automated packager:
   ```batch
   scripts\build_win.bat
   ```
2. *Note: If Python is not installed, the build script will automatically download and install Python 3.12 for you.*
3. Find the executable output in `dist\Primerool.exe`.

### Windows

1. Double-click **`Run_primerool.bat`**
2. If Python isn't installed, it's downloaded and installed automatically in the background.
3. The app installs all dependencies and launches as a native desktop application window.

### Development / Manual Setup

```bash
# Clone the repo
git clone https://github.com/your-username/Primerool.git
cd Primerool

# Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate        # macOS/Linux
# venv\Scripts\activate         # Windows

# Install dependencies
pip install -r requirements.txt

# Run
python src/app.py
```

Open **http://127.0.0.1:5050** in your browser.

---

## Architecture

```
Primerool/
├── src/
│   ├── app.py                 # Flask application (all routes)
│   ├── ensembl_api.py         # Ensembl REST API client
│   ├── ncbi_api.py            # NCBI E-Utilities API client
│   ├── blast_api.py           # NCBI BLAST integration
│   ├── primer_flanking.py     # WGA primer design (flanking regions)
│   ├── primer_junction.py     # Exon-exon junction primer design
│   ├── primer_internal.py     # Internal primer design
│   ├── primer_manual.py       # Manual region primer design
│   ├── primer_utils.py        # Shared Primer3 settings & analysis
│   ├── templates/
│   │   └── index.html         # Single-page frontend (vanilla JS)
│   └── static/
│       └── logo.png           # Primerool mascot
├── Run_primerool.command       # macOS launcher
├── Run_primerool.bat           # Windows launcher
├── requirements.txt
└── LICENSE                     # CC0 1.0 Universal
```

### Dependencies

| Package | Purpose |
|---|---|
| `flask` ≥ 3.0 | Web framework |
| `primer3-py` ≥ 2.0 | Primer design engine (Primer3 bindings) |
| `requests` ≥ 2.31 | HTTP client for Ensembl & NCBI APIs |

No database. No genome files. Everything is fetched on-the-fly.

---

## Typical Workflow

1. **Select organism** — pick kingdom + species, or enter a custom Ensembl name
2. **Search gene** — type a gene symbol or accession ID → get transcript list
3. **Configure sequence** — choose transcript, toggle introns/UTRs, set flanking bp
4. **View sequence** — explore the feature map and sequence map
5. **Design primers** — pick a mode (WGA, Junction, or Manual) → get ranked pairs
6. **Use primers** — click "Use" to highlight binding sites on the map

---

## License

[CC0 1.0 Universal](LICENSE) — public domain. Use freely for any purpose.
