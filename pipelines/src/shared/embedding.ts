/**
 * Client for OpenAI-compatible embeddings endpoints.
 *
 * The chiya routing layer uses cosine similarity between user-interest
 * embeddings and article-summary embeddings to decide which users get which
 * articles. The embeddings endpoint is separate from the chat-completions
 * tools/fast endpoints — qwen3-embed-8b served by a dedicated vllm in the
 * spark k8s cluster; reached via the `chiya-tunnel-embed.service` port-forward
 * (kubectl-managed, see systemd/).
 *
 * Cosine math itself lives in routing.ts; this module only owns the HTTP call.
 */

export interface EmbeddingTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface EmbeddingResult {
  /** Float vector. qwen3-embed-8b returns 1536 floats. */
  vector: number[];
  /** Position in the original input array — sanity check the SDK contract. */
  index: number;
}

export interface EmbedBatchOptions {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface ApiResponse {
  data: Array<{ index: number; embedding: number[] }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export async function embedBatch(
  texts: string[],
  target: EmbeddingTarget,
  options: EmbedBatchOptions = {},
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('embed-timeout'), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener(
      'abort',
      () => controller.abort(options.signal!.reason),
      { once: true },
    );
  }

  const url = `${target.baseUrl.replace(/\/$/, '')}/embeddings`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({ model: target.model, input: texts }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await safeBody(res);
    throw new Error(`embed request failed: ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as ApiResponse;
  if (!Array.isArray(json.data)) {
    throw new Error('embed response missing data array');
  }
  if (json.data.length !== texts.length) {
    throw new Error(
      `embed response count mismatch: requested=${texts.length} got=${json.data.length}`,
    );
  }

  // Defensive sort: vllm should return data in input order, but the OpenAI
  // contract carries an explicit index. Sort by it so the caller can map
  // result[i] back to input[i] without trusting wire order.
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => ({ vector: d.embedding, index: d.index }));
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<failed to read body>';
  }
}
