import {
  DEFAULT_LIMITS,
  defaultInstructionProfile,
  parseProviderAuth,
  parseProviderOptions,
  parseTranslateRequest,
  parseTranslateResponse,
  type TranslateRequest,
} from '@ai-translator-for-contentful/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider, providerHeaders } from '../src';

const profile = defaultInstructionProfile();
const request: TranslateRequest = {
  contract: 1,
  requestId: 'run-1',
  entryId: 'entry-a',
  model: 'test-model',
  sourceLocale: 'en-US',
  targetLocale: 'fr-FR',
  availableLocales: ['en-US', 'fr-FR'],
  profile,
  profileRevision: profile.revision,
  fields: [
    { id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source: 'Leave the line' },
    {
      id: 'f-tags',
      fieldId: 'tags',
      name: 'Tags',
      type: 'array',
      items: [
        { id: 'i0', text: 'Queue' },
        { id: 'i2', text: 'Line' },
      ],
    },
  ],
};
const answer =
  '<translation><field id="f-title" type="text">Plus besoin de faire la queue</field><field id="f-tags" type="array"><item id="i0">File</item><item id="i2">Ligne</item></field></translation>';
const config = {
  mode: 'openai-compatible' as const,
  endpoint: 'https://model.example/v1/chat/completions',
  auth: { mode: 'bearer' as const, secret: 'server-only-key' },
  allowedModels: ['test-model'],
};

afterEach(() => vi.useRealTimers());

function event(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}
function delta(content: string, finish?: string) {
  return { choices: [{ index: 0, delta: { content }, finish_reason: finish ?? null }] };
}
// A streamed response from chunks; a string chunk is UTF-8 encoded.
function stream(chunks: (string | Uint8Array)[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init },
  );
}
function streamed(content: string, finish = 'stop'): Response {
  const half = Math.floor(content.length / 2);
  return stream([event(delta(content.slice(0, half))), event(delta(content.slice(half), finish)), event('[DONE]')]);
}
function fetchInit(fetcher: { mock: { calls: Parameters<typeof fetch>[] } }): RequestInit {
  const init = fetcher.mock.calls[0]?.[1];
  if (!init) throw new Error('fetch was called without options');
  return init;
}

describe('provider adapter for contract 1', () => {
  it('returns deterministic mock results without network', async () => {
    const fetcher = vi.fn();
    const result = await createProvider({ mode: 'mock', allowedModels: ['test-model'] }, fetcher).translate(request);
    expect(result).toMatchObject({
      contract: 1,
      requestId: 'run-1',
      provider: 'mock',
      profileRevision: profile.revision,
      results: [
        { id: 'f-title', status: 'ok', type: 'text', text: 'Leave the line [fr-FR example]' },
        { id: 'f-tags', status: 'ok', type: 'array' },
      ],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('streams a completion with the key only in backend headers and reads keyed results', async () => {
    const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => streamed(answer));
    const result = await createProvider(config, fetcher).translate(parseTranslateRequest(request));
    expect(result.results).toEqual([
      { id: 'f-title', status: 'ok', type: 'text', text: 'Plus besoin de faire la queue' },
      {
        id: 'f-tags',
        status: 'ok',
        type: 'array',
        items: [
          { id: 'i0', text: 'File' },
          { id: 'i2', text: 'Ligne' },
        ],
      },
    ]);
    const init = fetchInit(fetcher);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer server-only-key');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'test-model', stream: true, n: 1 });
    expect(body.messages[1].content).toContain('<field id="f-title" fieldId="title" name="Title" type="text">');
    expect(JSON.stringify(result)).not.toContain('server-only-key');
  });

  it('adds the answer to a response with a failed field only in debug mode', async () => {
    const partial = '<translation><field id="f-title" type="text">File</field></translation>';
    const debugged = await createProvider({ ...config, debug: true }, async () => streamed(partial)).translate(request);
    expect(debugged.results[1]).toEqual({ id: 'f-tags', status: 'failed', error: 'missing' });
    expect(debugged.debug).toEqual({ answer: partial });
    expect(parseTranslateResponse(debugged, request)).toEqual(debugged);
    const plain = await createProvider(config, async () => streamed(partial)).translate(request);
    expect(plain).not.toHaveProperty('debug');
    const complete = await createProvider({ ...config, debug: true }, async () => streamed(answer)).translate(request);
    expect(complete).not.toHaveProperty('debug');
  });

  it('parses events across split UTF-8 sequences, lines and CRLF framing', async () => {
    const text =
      '<translation><field id="f-title">Café 👋</field><field id="f-tags"><item id="i0">a</item><item id="i2">b</item></field></translation>';
    const bytes = new TextEncoder().encode(
      `: keep-alive\r\n\r\n${event(delta(text.slice(0, 50)))}${event(delta(text.slice(50), 'stop'))}`.replaceAll(
        '\n\n',
        '\r\n\r\n',
      ),
    );
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < bytes.length; index += 7) chunks.push(bytes.slice(index, index + 7));
    const result = await createProvider(config, async () => stream(chunks)).translate(request);
    expect(result.results[0]).toMatchObject({ text: 'Café 👋' });
  });

  it('keeps a multiline event whole when a CRLF splits across chunks', async () => {
    // Pretty-printed JSON across two data lines; each chunk ends inside a CRLF.
    const lines = JSON.stringify(delta(answer, 'stop'), null, 1).split('\n');
    const first = `data: ${lines.slice(0, 3).join('\n')}`.replaceAll('\n', '\r\ndata: ');
    const rest = `data: ${lines.slice(3).join('\r\ndata: ')}`;
    const chunks = [`${first}\r`, `\n${rest}\r`, '\n\r', '\ndata: [DONE]\r\n\r\n'];
    const result = await createProvider(config, async () => stream(chunks)).translate(request);
    expect(result.results[0]).toMatchObject({ status: 'ok', text: 'Plus besoin de faire la queue' });
  });

  it('accepts a buffered JSON completion with a stop finish', async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ choices: [{ index: 0, message: { content: answer }, finish_reason: 'stop' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    expect((await createProvider(config, fetcher).translate(request)).results[0].status).toBe('ok');
  });

  it('classifies truncation, refusals, tool calls, errors and incomplete streams', async () => {
    const cases: [() => Response, string][] = [
      [() => streamed(answer, 'length'), 'provider_truncated'],
      [() => streamed(answer, 'content_filter'), 'provider_refused'],
      [
        () => stream([event({ choices: [{ index: 0, delta: { refusal: 'No.' }, finish_reason: 'stop' }] })]),
        'provider_refused',
      ],
      [
        () =>
          stream([
            event({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'x' }] }, finish_reason: 'tool_calls' }] }),
          ]),
        'invalid_provider_response',
      ],
      [() => stream([event(delta(answer)), event({ error: { message: 'overloaded' } })]), 'provider_failed'],
      [() => stream([event(delta(answer))]), 'provider_incomplete'],
      [() => stream([event(delta(answer)), event('[DONE]')]), 'provider_incomplete'],
      [() => stream([event('{not json')]), 'invalid_provider_response'],
      [() => stream([event(delta('', 'stop'))]), 'invalid_provider_response'],
      [() => streamed(answer.slice(0, answer.indexOf('</field>'))), 'invalid_provider_response'],
      [() => streamed(answer.replace('</translation>', '</field></translation>')), 'invalid_provider_response'],
      [() => stream([new Uint8Array([0xff, 0xfe])]), 'invalid_provider_response'],
      [() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }), 'invalid_provider_response'],
      [
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(event(delta(answer.slice(0, 20)))));
                controller.error(new TypeError('connection reset'));
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        'provider_incomplete',
      ],
    ];
    for (const [response, code] of cases)
      await expect(createProvider(config, async () => response()).translate(request), code).rejects.toThrow(code);
  });

  it('maps provider status codes, including size rejections', async () => {
    const cases: [Response, string][] = [
      [new Response('rate limited', { status: 429 }), 'provider_rate_limited'],
      [new Response('no', { status: 401 }), 'provider_auth_failed'],
      [new Response('too big', { status: 413 }), 'provider_request_too_large'],
      [
        new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 }),
        'provider_request_too_large',
      ],
      [new Response(JSON.stringify({ error: { code: 'invalid_model' } }), { status: 400 }), 'provider_failed'],
      [new Response('down', { status: 503 }), 'provider_failed'],
    ];
    for (const [response, code] of cases)
      await expect(createProvider(config, async () => response).translate(request)).rejects.toThrow(code);
  });

  it('counts generated bytes exactly when a surrogate pair is split across deltas', async () => {
    const emoji = answer.replace('File', 'File 😀');
    const split = emoji.indexOf('😀') + 1;
    const chunks = () => [event(delta(emoji.slice(0, split))), event(delta(emoji.slice(split), 'stop'))];
    const bytes = new TextEncoder().encode(emoji).length;
    const limited = (generatedBytes: number) =>
      createProvider({ ...config, limits: { ...DEFAULT_LIMITS, generatedBytes } }, async () => stream(chunks()));
    expect((await limited(bytes).translate(request)).results[0].status).toBe('ok');
    await expect(limited(bytes - 1).translate(request)).rejects.toThrow('result_too_large');
  });

  it('bounds stream events, total wire bytes, generated content and results', async () => {
    const limits = { ...DEFAULT_LIMITS, eventBytes: 1_024 };
    await expect(
      createProvider({ ...config, limits }, async () => stream([event(delta('x'.repeat(2_000), 'stop'))])).translate(
        request,
      ),
    ).rejects.toThrow('invalid_provider_response');
    await expect(
      createProvider({ ...config, limits: { ...DEFAULT_LIMITS, streamBytes: 200 } }, async () =>
        streamed(answer),
      ).translate(request),
    ).rejects.toThrow('result_too_large');
    await expect(
      createProvider({ ...config, limits: { ...DEFAULT_LIMITS, generatedBytes: 100 } }, async () =>
        streamed(answer),
      ).translate(request),
    ).rejects.toThrow('result_too_large');
    await expect(
      createProvider({ ...config, limits: { ...DEFAULT_LIMITS, resultBytes: 100 } }, async () =>
        streamed(answer),
      ).translate(request),
    ).rejects.toThrow('result_too_large');
    const fetcher = vi.fn();
    await expect(
      createProvider({ ...config, limits: { ...DEFAULT_LIMITS, providerBodyBytes: 1_000 } }, fetcher).translate(
        request,
      ),
    ).rejects.toThrow('request_too_large');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('times out on the first byte, an idle stream and the total deadline', async () => {
    const never = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    await expect(createProvider({ ...config, idleTimeoutMs: 20 }, never).translate(request)).rejects.toThrow(
      'provider_timeout',
    );
    const stalled = (_url: unknown, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(event(delta('<translation>'))));
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('aborted', 'AbortError')),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    await expect(createProvider({ ...config, idleTimeoutMs: 20 }, stalled).translate(request)).rejects.toThrow(
      'provider_timeout',
    );
    // A trickle that keeps the idle timer alive still ends at the deadline.
    const trickle = (_url: unknown, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              const timer = setInterval(() => controller.enqueue(new TextEncoder().encode(': ping\n\n')), 5);
              init?.signal?.addEventListener('abort', () => {
                clearInterval(timer);
                controller.error(new DOMException('aborted', 'AbortError'));
              });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    await expect(
      createProvider({ ...config, idleTimeoutMs: 1_000 }, trickle).translate(request, { deadline: Date.now() + 60 }),
    ).rejects.toThrow('provider_timeout');
    const fetcher = vi.fn();
    await expect(createProvider(config, fetcher).translate(request, { deadline: Date.now() - 1 })).rejects.toThrow(
      'provider_timeout',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('supports a custom authentication header and bounded admin request options', async () => {
    const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => streamed(answer));
    const provider = createProvider(
      {
        ...config,
        auth: { mode: 'header', name: 'X-API-Key', secret: 'server-only-key' },
        additionalHeaders: { 'X-Provider-Version': '2026-01-01' },
        options: parseProviderOptions({
          temperature: '0.1',
          topP: 0.9,
          maxCompletionTokens: 256,
          reasoningEffort: 'low',
          extraBody: '{"seed":12,"presence_penalty":0.2}',
        }),
      },
      fetcher,
    );
    const result = await provider.translate(request);
    const init = fetchInit(fetcher);
    expect(init.headers).toMatchObject({ 'x-api-key': 'server-only-key', 'x-provider-version': '2026-01-01' });
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      n: 1,
      temperature: 0.1,
      top_p: 0.9,
      max_completion_tokens: 256,
      reasoning_effort: 'low',
      seed: 12,
      presence_penalty: 0.2,
    });
    expect(JSON.stringify(result)).not.toContain('server-only-key');
  });

  it('allows an explicitly unauthenticated provider and rejects unsafe headers or body overrides', async () => {
    const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => streamed(answer));
    await createProvider({ ...config, auth: { mode: 'none' as const } }, fetcher).translate(request);
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('authorization');
    expect(() => parseProviderOptions({ extraBody: '{"messages":[]}' })).toThrow('invalid_provider_options');
    expect(() => parseProviderOptions({ extraBody: '{"stream_options":{}}' })).toThrow('invalid_provider_options');
    expect(() => parseProviderOptions({ temperature: 2.1 })).toThrow('invalid_provider_options');
    expect(providerHeaders(parseProviderAuth('header', 'Token server-only-key', 'Authorization')).authorization).toBe(
      'Token server-only-key',
    );
    await expect(
      createProvider(
        { ...config, auth: { mode: 'none' as const }, additionalHeaders: { Host: 'other.example' } },
        fetcher,
      ).translate(request),
    ).rejects.toThrow('invalid_provider_headers');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects disallowed models and insecure endpoints, and compiles with a trusted profile', async () => {
    await expect(createProvider({ mode: 'mock', allowedModels: [] }).translate(request)).rejects.toThrow(
      'model_not_allowed',
    );
    await expect(createProvider({ ...config, endpoint: 'http://model.example' }).translate(request)).rejects.toThrow(
      'invalid_provider_endpoint',
    );
    const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => streamed(answer));
    const trustedProfile = { ...profile, alwaysApplied: 'Trusted brand voice.' };
    await createProvider({ ...config, trustedProfile }, fetcher).translate(request);
    expect(JSON.parse(String(fetchInit(fetcher).body)).messages[0].content).toContain('Trusted brand voice.');
  });
});
