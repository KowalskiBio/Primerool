import { useState } from 'react';
import { searchGene } from '../api/gene';
import { blastSequence, type BlastHit } from '../api/blast';
import type { Transcript } from '../api/gene';
import type { SequenceData } from '../api/sequence';
import { isAccessionId, cleanDNA } from '../utils/dna';
import { SPECIES_BY_KINGDOM, KINGDOM_LABELS, findKingdomForSpecies, type Kingdom } from '../utils/species';
import BlastResultsTable from './BlastResultsTable';
import SnpBatchPanel from './SnpBatchPanel';
import SegmentedControl from './ui/SegmentedControl';
import Field from './ui/Field';
import TextInput from './ui/TextInput';
import Select from './ui/Select';
import Button from './ui/Button';
import { controlClasses } from './ui/TextInput';

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
  const [showSnpBatch, setShowSnpBatch] = useState(false);

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
      setSuccess(`Accession '${accession}' identified as ${top.organism} (${top.gene_symbol}). Loading gene data…`);
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
      setSuccess(`Input '${input}' looks like an Accession ID. Resolving…`);
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
    setSuccess(`Identified: ${hit.organism} (${hit.gene_symbol}). Searching Ensembl…`);
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
      <SegmentedControl
        className="mb-6"
        ariaLabel="Input mode"
        value={inputMode}
        onChange={setInputMode}
        options={[
          { value: 'gene', label: 'Search by Gene Name' },
          { value: 'fasta', label: 'Paste a Sequence (FASTA)' },
        ]}
      />

      {inputMode === 'gene' && (
        <>
          <Field label="Data Source" className="mb-4">
            <SegmentedControl
              size="sm"
              ariaLabel="Data source"
              value={apiSource}
              onChange={setApiSource}
              options={[
                { value: 'ensembl', label: 'Ensembl' },
                { value: 'ncbi', label: 'NCBI' },
              ]}
            />
          </Field>

          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-ink-muted">Organism</label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                aria-label="Kingdom"
                value={kingdom}
                onChange={(e) => {
                  const k = e.target.value as Kingdom;
                  setKingdom(k);
                  setSpeciesValue(SPECIES_BY_KINGDOM[k][0]?.value || '');
                }}
              >
                {(Object.keys(KINGDOM_LABELS) as Kingdom[]).map((k) => (
                  <option key={k} value={k}>
                    {KINGDOM_LABELS[k]}
                  </option>
                ))}
              </Select>
              <Select aria-label="Species" value={speciesValue} onChange={(e) => setSpeciesValue(e.target.value)}>
                {speciesOptions.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
            {speciesValue === '__custom__' && (
              <div className="mt-2">
                <TextInput
                  type="text"
                  spellCheck={false}
                  value={customSpecies}
                  onChange={(e) => setCustomSpecies(e.target.value)}
                  placeholder="e.g. escherichia_coli_str_k_12_substr_mg1655…"
                />
                <p className="mt-1 text-xs text-ink-faint">
                  Enter the Ensembl species name (lowercase, underscores).{' '}
                  <a href="https://rest.ensembl.org/info/species?content-type=application/json" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    Browse all species
                  </a>
                </p>
              </div>
            )}
          </div>

          <Field label="Gene Name or Accession ID" htmlFor="gene-input">
            <div className="flex gap-3">
              <input
                id="gene-input"
                type="text"
                value={geneInput}
                onChange={(e) => setGeneInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleGeneSearch();
                }}
                placeholder="e.g. CHAT or NR_132312.2…"
                className="h-9 flex-1 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
              />
              <Button variant="primary" disabled={searching} onClick={() => void handleGeneSearch()}>
                {searching ? 'Searching…' : 'Search'}
              </Button>
            </div>
          </Field>
        </>
      )}

      {inputMode === 'fasta' && (
        <div>
          <Field label="Paste your sequence (raw or FASTA format)" htmlFor="fasta-input">
            <textarea
              id="fasta-input"
              rows={6}
              value={fastaInput}
              onChange={(e) => setFastaInput(e.target.value)}
              placeholder={'>optional_header\nATGCGTACGATCGATCGATCGATCG…'}
              className={`${controlClasses} mb-3 font-mono leading-relaxed resize-y`}
            />
          </Field>

          <div className="flex flex-wrap gap-3">
            <Button variant="primary" disabled={blastRunning} onClick={() => void identifySequence()} className="w-full sm:w-auto">
              {blastRunning ? 'Running BLAST…' : 'Identify Sequence (NCBI BLAST)'}
            </Button>
            <Button onClick={useCustomSequence} className="w-full sm:w-auto">
              Use Custom Sequence
            </Button>
            <Button onClick={() => setShowSnpBatch((v) => !v)} className="w-full sm:w-auto">
              {showSnpBatch ? 'Hide SNP batch importer' : 'Import SNP flanking blocks (batch)'}
            </Button>
          </div>

          {showSnpBatch && (
            <div className="mt-4">
              <SnpBatchPanel />
            </div>
          )}

          {blastRunning && (
            <div className="mt-4 rounded-md border border-line bg-surface-2 px-4 py-3" role="status">
              <div className="mb-2 flex items-baseline gap-2">
                <strong className="text-sm text-ink">Running NCBI BLAST…</strong>
                <span className="text-sm text-ink-muted">This may take up to 2 minutes. Please wait.</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear" style={{ width: `${blastProgress}%` }} />
              </div>
            </div>
          )}

          {blastHits && (
            <div className="mt-4">
              <h3 className="mb-3 text-sm font-semibold text-ink">BLAST Results</h3>
              <BlastResultsTable hits={blastHits} onUse={useBlastHit} />
            </div>
          )}
        </div>
      )}

      {error && <div role="alert" className="mt-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5 text-sm font-medium text-danger">{error}</div>}
      {success && <div role="status" className="mt-4 mb-2 rounded-md border border-success/25 bg-success-subtle px-3 py-2.5 text-sm font-medium text-success">{success}</div>}
    </div>
  );
}
