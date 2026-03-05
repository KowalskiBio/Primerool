import { defineConfig } from 'vite';

// Proxy API requests to Flask backend running on port 5050
export default defineConfig({
  server: {
    proxy: {
      '/blast_sequence': 'http://127.0.0.1:5050',
      '/search_gene': 'http://127.0.0.1:5050',
      '/get_sequence': 'http://127.0.0.1:5050',
      '/design_manual_primer': 'http://127.0.0.1:5050',
      '/design_primers': 'http://127.0.0.1:5050',
      '/analyze_manual_primers': 'http://127.0.0.1:5050',
      '/design_from_sequence': 'http://127.0.0.1:5050',
      '/design_probe': 'http://127.0.0.1:5050',
      // proxy any other potential API routes if needed
    }
  }
});
