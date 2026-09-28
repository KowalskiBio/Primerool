/** Reads the per-browser NCBI API key fresh at request time, so components
 * deep in the tree (BlastModal, InputPanel) pick up key changes made in the
 * settings modal without prop-drilling or a context. The key is written by
 * App.tsx under the same `ncbi_api_key` localStorage key Oligool uses. */
export function getNcbiApiKey(): string {
  return localStorage.getItem('ncbi_api_key')?.trim() ?? '';
}
