import { describe, expect, it, vi } from 'vitest';
import { listProviderModels, MODEL_LIST_MAX_BYTES, MODEL_LIST_MAX_ENTRIES } from '../src';

const config = {
  endpoint: 'https://model.example/v1/models',
  auth: { mode: 'bearer' as const, secret: 'server-only-key' },
  additionalHeaders: { 'x-provider-version': '1' },
};
const listing = (ids: unknown[]) =>
  vi.fn(
    async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, owned_by: 'example' })) })),
  );

describe('provider model discovery', () => {
  it('lists valid IDs sorted and deduplicated with the translation credentials and no model call', async () => {
    const fetcher = listing(['b-model', 'a-model', 'b-model', 'mock', '', 'bad id', 42, 'org/model:tag']);
    expect(await listProviderModels(config, fetcher)).toEqual(['a-model', 'b-model', 'org/model:tag']);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://model.example/v1/models');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({ authorization: 'Bearer server-only-key', 'x-provider-version': '1' });
  });
  it('accepts an empty list', async () => {
    expect(await listProviderModels(config, listing([]))).toEqual([]);
  });
  it('accepts the entry and byte limits and refuses anything beyond them', async () => {
    const ids = Array.from({ length: MODEL_LIST_MAX_ENTRIES }, (_, index) => `model-${index}`);
    expect(await listProviderModels(config, listing(ids))).toHaveLength(MODEL_LIST_MAX_ENTRIES);
    await expect(listProviderModels(config, listing([...ids, 'one-more']))).rejects.toThrow('model_list_unavailable');
    const body = (size: number) => {
      const base = JSON.stringify({ data: [{ id: 'a-model' }], pad: '' });
      return JSON.stringify({ data: [{ id: 'a-model' }], pad: 'x'.repeat(size - base.length) });
    };
    expect(await listProviderModels(config, async () => new Response(body(MODEL_LIST_MAX_BYTES)))).toEqual(['a-model']);
    await expect(listProviderModels(config, async () => new Response(body(MODEL_LIST_MAX_BYTES + 1)))).rejects.toThrow(
      'model_list_unavailable',
    );
    await expect(
      listProviderModels(
        config,
        async () => new Response('{}', { headers: { 'content-length': String(MODEL_LIST_MAX_BYTES + 1) } }),
      ),
    ).rejects.toThrow('model_list_unavailable');
  });
  it.each([
    ['unsuccessful', () => new Response('upstream-detail', { status: 404 })],
    ['unauthorized', () => new Response('upstream-detail', { status: 401 })],
    ['redirected', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })],
    ['malformed JSON', () => new Response('{"data":')],
    ['non-UTF-8', () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]))],
    ['missing data', () => new Response('{"models":[]}')],
    ['non-array data', () => new Response('{"data":{}}')],
  ])('refuses a %s response with a safe code', async (_label, upstream) => {
    const error = await listProviderModels(config, async () => upstream()).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('model_list_unavailable');
  });
  it('refuses a timeout, a network failure, and an unsafe endpoint', async () => {
    const timedOut = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
        ),
    );
    await expect(listProviderModels({ ...config, timeoutMs: 5 }, timedOut)).rejects.toThrow('model_list_unavailable');
    await expect(
      listProviderModels(config, async () => {
        throw new TypeError('network detail with server-only-key');
      }),
    ).rejects.toThrow(/^model_list_unavailable$/);
    const fetcher = listing(['a-model']);
    for (const endpoint of ['http://model.example/v1/models', 'https://model.example/v1/models?key=x'])
      await expect(listProviderModels({ ...config, endpoint }, fetcher)).rejects.toThrow('model_list_unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
