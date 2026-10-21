import { getNcbiApiKey } from './ncbiApiKey';

/**
 * Shared POST-JSON helper for every route in `crates/server`. All six
 * routes return `{"error": "..."}` on failure (see `crates/server/src/error.rs`'s
 * `AppError` -> JSON mapping) — that's the one thing worth centralizing;
 * everything else about each route's shape is specific enough (see
 * `gene.ts`/`sequence.ts`/`blast.ts`/`design.ts`) that a single generic
 * request builder isn't worth forcing on top of it.
 */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readResponse<TRes>(response: Response): Promise<TRes> {
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body (shouldn't happen against a real axum error response,
      // but a proxy/timeout in front of the server could still produce one).
      if (!response.ok) {
        throw new ApiError(response.status, text.slice(0, 200) || `HTTP ${response.status}`);
      }
    }
  }

  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }

  return data as TRes;
}

/** Sends the Settings NCBI API key on every request; the server applies it
 * to every NCBI E-utilities call it makes while serving that request. */
function ncbiKeyHeader(): Record<string, string> {
  const key = getNcbiApiKey();
  return key ? { 'X-NCBI-API-Key': key } : {};
}

export async function postJson<TRes>(path: string, body: unknown): Promise<TRes> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ncbiKeyHeader() },
    body: JSON.stringify(body),
  });
  return readResponse<TRes>(response);
}

/** GET counterpart of `postJson` for the few polling-style routes
 * (`/blast_batch_status/:id`): same `{"error": ...}` handling. */
export async function getJson<TRes>(path: string): Promise<TRes> {
  const response = await fetch(path, { headers: ncbiKeyHeader() });
  return readResponse<TRes>(response);
}
