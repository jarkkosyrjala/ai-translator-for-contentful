import { type ProviderAuth, validModelId } from '@ai-translator-for-contentful/protocol';
import { providerHeaders } from './headers';

// Bounds of a provider's model list response. A larger response is refused,
// never truncated.
export const MODEL_LIST_MAX_BYTES = 4_194_304;
export const MODEL_LIST_MAX_ENTRIES = 1000;

export type ModelListConfig = {
  // The provider's `/models` URL.
  endpoint: string;
  auth: ProviderAuth;
  additionalHeaders?: Record<string, string>;
  timeoutMs?: number;
};

async function readBounded(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > MODEL_LIST_MAX_BYTES || !response.body)
    throw new Error('model_list_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MODEL_LIST_MAX_BYTES) {
      await reader.cancel();
      throw new Error('model_list_unavailable');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/**
 * Lists the model IDs an OpenAI-compatible provider returns from `GET /models`
 * (`{ "data": [{ "id": "…" }] }`). Keeps only valid IDs other than `mock`,
 * deduplicated and sorted, and discards all other metadata. No model is called.
 * @throws Error `model_list_unavailable` for any failed, redirected, timed-out,
 *   oversized, or malformed response.
 */
export async function listProviderModels(config: ModelListConfig, fetcher: typeof fetch = fetch): Promise<string[]> {
  const url = new URL(config.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new Error('model_list_unavailable');
  const { 'content-type': _json, ...headers } = providerHeaders(config.auth, config.additionalHeaders);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 25_000);
  let data: unknown;
  try {
    // Contentful's edge fetch supports manual redirect handling, not redirect: 'error'.
    const response = await fetcher(url.href, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' });
    if (!response.ok) throw new Error('model_list_unavailable');
    data = await readBounded(response);
  } catch {
    throw new Error('model_list_unavailable');
  } finally {
    clearTimeout(timeout);
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !('data' in data) ||
    !Array.isArray(data.data) ||
    data.data.length > MODEL_LIST_MAX_ENTRIES
  )
    throw new Error('model_list_unavailable');
  const ids = new Set<string>();
  for (const item of data.data as unknown[])
    if (item && typeof item === 'object' && 'id' in item && validModelId(item.id)) ids.add(item.id);
  return [...ids].sort();
}
