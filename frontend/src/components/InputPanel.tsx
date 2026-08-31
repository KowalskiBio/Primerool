import { useState } from 'react';
import { searchGene } from '../api/gene';
import { blastSequence, type BlastHit } from '../api/blast';
import type { Transcript } from '../api/gene';
import type { SequenceData } from '../api/sequence';
import { isAccessionId, cleanDNA } from '../utils/dna';
import { SPECIES_BY_KINGDOM, KINGDOM_LABELS, findKingdomForSpecies, type Kingdom } from '../utils/species';
import BlastResultsTable from './BlastResultsTable';

interface Props {
  onGeneFound: (geneName: string, species: string, apiSource: 'ensembl' | 'ncbi', transcripts: Transcript[]) => void;
  onCustomSequence: (data: SequenceData) => void;
}

export default function InputPanel({ onGeneFound, onCustomSequence }: Props) {
  const [inputMode, setInputMode] = useState<'gene' | 'fasta'>('gene');
  const [apiSource, setApiSource] = useState<'ensembl' | 'ncbi'>('ncbi');
  const [kingdom, setKingdom] = useState<Kingdom>('animals');
  const [speciesValue, setSpeciesValue] = useState('homo_sapiens');
  const [customSpecies, setCustomSpecies] = useState('');
  const [geneInput, setGeneInput] = useState('');
  const [fastaInput, setFastaInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [blastRunning, setBlastRunning] = useState(false);
  const [blastProgress, setBlastProgress] = useState(0);
  const [blastHits, setBlastHits] = useState<BlastHit[] | null>(null);

  const effectiveSpecies = speciesValue === '__custom__' ? customSpecies.trim() : speciesValue;

  function syncDropdownsToSpecies(species: string) {
    const found = findKingdomForSpecies(species);
    if (found) {
      setKingdom(found);
      setSpeciesValue(species);
      setCustomSpecies('');
    } else {
      setKingdom('animals');
      setSpeciesValue('__custom__');
      setCustomSpecies(species);
    }
  }

  async function runSearchGene(geneName: string, species: string, source: 'ensembl' | 'ncbi') {
    setError(null);
    setSearching(true);
    try {
      const data = await searchGene({ gene_name: geneName, species, api_source: source });
      setSuccess(`Gene ${data.gene_name} found with ${data.transcripts.length} transcript(s).`);
      onGeneFound(data.gene_name, species, source, data.transcripts);
    } catch (e) {
      setSuccess(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  async function resolveAccessionAndSearch(accession: string) {
    setError(null);
    try {
      const data = await blastSequence(accession);
      const hits = data.hits || [];
      if (!hits.length) throw new Error('No BLAST hits found for this Accession ID.');
      const top = hits[0];
      if (!top.gene_symbol) {
        throw new Error(`Accession identified as '${top.organism}' but no Gene Symbol found. Please try searching by Sequence to view full results.`);
      }
      const species = top.ensembl_species || 'homo_sapiens';
      setSuccess(`Accession '${accession}' identified as ${top.organism} — ${top.gene_symbol}. Loading gene data...`);
      await runSearchGene(top.gene_symbol, species, apiSource);
    } catch (e) {
      setSuccess(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleGeneSearch() {
    const input = geneInput.trim();
    if (!input) return;
    setError(null);
    setSuccess(null);

    if (isAccessionId(input)) {
      setSuccess(`Input '${input}' looks like an Accession ID. Resolving via BLAST...`);
      await resolveAccessionAndSearch(input);
    } else {
      await runSearchGene(input, effectiveSpecies || 'homo_sapiens', apiSource);
    }
  }

  async function identifySequence() {
    const raw = fastaInput.trim();
    setError(null);
    setSuccess(null);
    setBlastHits(null);

    const seqLen = raw.replace(/^>.*$/gm, '').replace(/\s/g, '').length;
    if (!isAccessionId(raw) && seqLen < 20) {
      setError('Please paste a valid Accession ID or a sequence of at least 20 bp.');
      return;
    }

    setBlastRunning(true);
    setBlastProgress(0);
    const progressTimer = setInterval(() => {
      setBlastProgress((p) => Math.min(p + 1, 95));
    }, 1200);

    try {
      const data = await blastSequence(raw);
      const hits = data.hits || [];
      if (!hits.length) {
        setError('No significant matches found.');
        return;
      }
      setBlastHits(hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(progressTimer);
      setBlastProgress(100);
      setBlastRunning(false);
    }
  }

  function useBlastHit(hit: BlastHit) {
    setInputMode('gene');
    const species = hit.ensembl_species || 'homo_sapiens';
    syncDropdownsToSpecies(species);

    if (!hit.gene_symbol) {
      setGeneInput('');
      setSuccess(`Organism identified as ${hit.organism || 'Unknown'}. Gene symbol not found in BLAST result. Please check the Description and enter the gene name manually above.`);
      setError(null);
      return;
    }

    setGeneInput(hit.gene_symbol);
    setSuccess(`Identified: ${hit.organism} — ${hit.gene_symbol}. Searching Ensembl...`);
    void runSearchGene(hit.gene_symbol, species, apiSource);
  }

  function useCustomSequence() {
    setError(null);
    const lines = fastaInput.split(/\r?\n/);
    const seqLines = lines.filter((l) => l.trim() && !l.trim().startsWith('>'));
    const sequence = cleanDNA(seqLines.join(''));

    if (sequence.length < 20) {
      setError('Sequence too short (need at least 20 bp). Please paste a valid DNA sequence.');
      return;
    }

    const data: SequenceData = {
      gene_name: 'Custom sequence',
      transcript_id: 'custom',
      transcript_name: 'Custom sequence',
      chrom: '',
      strand: '+',
      gene_start_genomic: 0,
      gene_end_genomic: 0,
      upstream_len: 0,
      gene_len: sequence.length,
      downstream_len: 0,
      utr5_len: 0,
      upstream_seq: '',
      gene_seq: sequence,
      downstream_seq: '',
      spliced_seq: sequence,
      spliced_exons_seq: sequence,
      junctions: [],
      annotations: [],
      include_introns: false,
      include_utr: false,
    };
    setSuccess(`Custom sequence loaded (${sequence.length} bp). Scroll down to view the sequence and design primers.`);
    onCustomSequence(data);
  }

  const speciesOptions = SPECIES_BY_KINGDOM[kingdom];

  return (
    <div>
      <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-4">How would you like to start?</h2>

      <div className="flex flex-wrap gap-4 mb-6">
        <label className="flex items-center gap-2 cursor-pointer bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
          <input type="radio" name="inputMode" checked={inputMode === 'gene'} onChange={() => setInputMode('gene')} className="accent-green-600 w-4 h-4" />
          <span className="font-medium text-slate-700 dark:text-slate-200">Search by Gene Name</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer bg-gradient-to-br from-green-50 to-emerald-50/30 dark:from-slate-800 dark:to-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
          <input type="radio" name="inputMode" checked={inputMode === 'fasta'} onChange={() => setInputMode('fasta')} className="accent-green-600 w-4 h-4" />
          <span className="font-medium text-slate-700 dark:text-slate-200">Paste a Sequence (FASTA)</span>
        </label>
      </div>

      {inputMode === 'gene' && (
        <>
          <div className="mb-3">
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Data Source</label>
            <div className="flex gap-2">
              <button
                onClick={() => setApiSource('ensembl')}
                className={`px-3 py-1 text-xs rounded-full font-medium transition-colors border ${apiSource === 'ensembl' ? 'border-green-500 bg-green-500 text-white' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:border-green-400'}`}
              >
                Ensembl
              </button>
              <button
                onClick={() => setApiSource('ncbi')}
                className={`px-3 py-1 text-xs rounded-full font-medium transition-colors border ${apiSource === 'ncbi' ? 'border-green-500 bg-green-500 text-white' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:border-green-400'}`}
              >
                NCBI
              </button>
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Organism</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select
                value={kingdom}
                onChange={(e) => {
                  const k = e.target.value as Kingdom;
                  setKingdom(k);
                  setSpeciesValue(SPECIES_BY_KINGDOM[k][0]?.value || '');
                }}
                className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm focus:border-green-500 focus:ring-green-500 text-sm px-3 py-2 border"
              >
                {(Object.keys(KINGDOM_LABELS) as Kingdom[]).map((k) => (
                  <option key={k} value={k}>
                    {KINGDOM_LABELS[k]}
                  </option>
                ))}
              </select>
              <select
                value={speciesValue}
                onChange={(e) => setSpeciesValue(e.target.value)}
                className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm focus:border-green-500 focus:ring-green-500 text-sm px-3 py-2 border"
              >
                {speciesOptions.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            {speciesValue === '__custom__' && (
              <div className="mt-2">
                <input
                  type="text"
                  value={customSpecies}
                  onChange={(e) => setCustomSpecies(e.target.value)}
                  placeholder="e.g. escherichia_coli_str_k_12_substr_mg1655"
                  className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm focus:border-green-500 focus:ring-green-500 text-sm px-3 py-2 border"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Enter the Ensembl species name (lowercase, underscores).{' '}
                  <a href="https://rest.ensembl.org/info/species?content-type=application/json" target="_blank" rel="noreferrer" className="text-green-600 hover:underline">
                    Browse all species
                  </a>
                </p>
              </div>
            )}
          </div>

          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Gene Name or Accession ID</label>
          <div className="flex gap-3">
            <input
              type="text"
              value={geneInput}
              onChange={(e) => setGeneInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleGeneSearch();
              }}
              placeholder="e.g., CHAT or NR_132312.2"
              className="flex-1 rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm focus:border-green-500 focus:ring-green-500 text-sm px-3 py-2 border"
            />
            <button
              disabled={searching}
              onClick={() => void handleGeneSearch()}
              className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm"
            >
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
        </>
      )}

      {inputMode === 'fasta' && (
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Paste your sequence (raw or FASTA format)</label>
          <textarea
            rows={6}
            value={fastaInput}
            onChange={(e) => setFastaInput(e.target.value)}
            placeholder={'>optional_header\nATGCGTACGATCGATCGATCGATCG...'}
            className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm focus:border-green-500 focus:ring-green-500 font-mono text-sm p-3 border resize-y mb-3"
          />

          <div className="flex flex-wrap gap-3">
            <button
              disabled={blastRunning}
              onClick={() => void identifySequence()}
              className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors shadow-sm w-full sm:w-auto"
            >
              {blastRunning ? 'Running BLAST...' : 'Identify Sequence (NCBI BLAST)'}
            </button>
            <button
              onClick={useCustomSequence}
              className="bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-green-50 dark:hover:bg-slate-600 font-medium rounded-lg px-5 py-2 transition-colors shadow-sm w-full sm:w-auto"
            >
              Use Custom Sequence
            </button>
          </div>

          {blastRunning && (
            <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <strong className="text-amber-800 dark:text-amber-300">Running NCBI BLAST...</strong>
                <span className="text-sm text-amber-700 dark:text-amber-400">This may take up to 2 minutes. Please wait.</span>
              </div>
              <div className="w-full h-2 bg-amber-100 dark:bg-amber-950 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 transition-all duration-1000 ease-linear" style={{ width: `${blastProgress}%` }} />
              </div>
            </div>
          )}

          {blastHits && (
            <div className="mt-4">
              <h3 className="text-md font-semibold text-slate-800 dark:text-slate-200 mb-3">BLAST Results</h3>
              <BlastResultsTable hits={blastHits} onUse={useBlastHit} />
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm font-medium">{error}</div>}
      {success && <div className="mt-4 mb-6 p-4 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 rounded-lg text-emerald-700 dark:text-emerald-300 text-sm font-medium">{success}</div>}
    </div>
  );
}
