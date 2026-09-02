import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  publicDir: 'public_static',
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    // In production (Tauri, or the built `dist/` served by axum's
    // ServeDir), the frontend and API share one origin, so plain relative
    // fetch('/search_gene') calls just work. In `npm run dev` the Vite dev
    // server owns its own port, so API calls need forwarding to the real
    // `primerool-server` (run separately, e.g. `cargo run -p server`) —
    // mirrors the legacy app's own dev-mode proxy setup.
    proxy: {
      '/search_gene': 'http://127.0.0.1:5050',
      '/get_sequence': 'http://127.0.0.1:5050',
      '/blast_sequence': 'http://127.0.0.1:5050',
      '/design_primers': 'http://127.0.0.1:5050',
      '/design_from_sequence': 'http://127.0.0.1:5050',
      '/design_probe': 'http://127.0.0.1:5050',
      '/analyze_primer': 'http://127.0.0.1:5050',
      '/analyze_structure': 'http://127.0.0.1:5050',
      '/search_variants': 'http://127.0.0.1:5050',
      '/lookup_variant': 'http://127.0.0.1:5050',
      '/design_arms': 'http://127.0.0.1:5050',
      '/align': 'http://127.0.0.1:5050',
      '/design_conserved': 'http://127.0.0.1:5050',
      '/idt': 'http://127.0.0.1:5050',
    },
  },
})
