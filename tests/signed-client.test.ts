import { createHmac } from 'node:crypto';
import type { BaseAppSDK } from '@contentful/app-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHOICE_UNAVAILABLE } from '../apps/contentful-app/src/app/choices';
import { RelayError, signedHealth, signedModels, signedTranslate } from '../apps/contentful-app/src/app/signed';
import worker from '../backends/cloudflare-worker/src/worker';
import { defaultInstructionProfile, type TranslateRequest } from '../packages/protocol/src';
import { createRelayHandler } from '../packages/relay/src';

const profile = defaultInstructionProfile();
const limits = { requestBytes: 2_097_152, providerBodyBytes: 4_194_304, resultBytes: 4_194_304 };
const translation = (change: Partial<TranslateRequest> = {}): TranslateRequest => ({
  contract: 1,
  requestId: 'r1',
  entryId: 'entry-a',
  model: 'test-model',
  sourceLocale: 'en',
  targetLocale: 'fr',
  availableLocales: ['en', 'fr', 'fi'],
  profile,
  profileRevision: profile.revision,
  fields: [{ id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source: 'Hello' }],
  ...change,
});
const translated = (text: string, provider = 'openai-compatible') => ({
  contract: 1,
  requestId: 'r1',
  provider,
  profileRevision: profile.revision,
  results: [{ id: 'f-title', status: 'ok', type: 'text', text }],
});

const signingSecret = 'b'.repeat(64);
const env = {
  RELAY_CONFIG: JSON.stringify({
    appDefinitions: { app: { signingSecretRef: 'APP_SIGNING', spaces: { space: ['primary'] } } },
    providers: {
      primary: { baseUrl: 'https://model.example/v1', model: 'test-model', credentialRef: 'MODEL_CREDENTIAL' },
    },
  }),
  APP_SIGNING: signingSecret,
  MODEL_CREDENTIAL: 'server-only-key',
  MOCK_TRANSLATION_ENABLED: 'true',
};
const sign = vi.fn(
  async (_ids: unknown, request: { method: string; path: string; headers: Record<string, string>; body: string }) => {
    const timestamp = String(Date.now());
    const headers: Record<string, string> = {
      ...request.headers,
      'x-contentful-space-id': 'space',
      'x-contentful-environment-id': 'master',
      'x-contentful-user-id': 'user',
      'x-contentful-timestamp': timestamp,
    };
    const names = [...Object.keys(headers), 'x-contentful-signed-headers'].sort();
    headers['x-contentful-signed-headers'] = names.join(',');
    const canonical = [
      request.method,
      request.path,
      names.map(name => `${name}:${headers[name]}`).join(';'),
      request.body,
    ].join('\n');
    headers['x-contentful-signature'] = createHmac('sha256', signingSecret).update(canonical).digest('hex');
    return { additionalHeaders: headers };
  },
);
const sdk = {
  ids: { space: 'space', environment: 'master', app: 'app' },
  cma: { appSignedRequest: { create: sign } },
} as unknown as Pick<BaseAppSDK, 'ids' | 'cma'>;
afterEach(() => {
  vi.unstubAllGlobals();
  sign.mockClear();
});

describe('browser signed client to Worker boundary', () => {
  it('sends the exact signed body and validates no-model health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, options: RequestInit) =>
        worker.fetch(
          new Request(url, { ...options, headers: { ...options.headers, origin: 'https://app.example' } }),
          env,
        ),
      ),
    );
    expect(await signedHealth(sdk, 'https://relay.example')).toEqual({
      contract: 1,
      status: 'ok',
      modelCall: false,
      providerConfigured: false,
      providers: [{ alias: 'primary', model: 'test-model', host: 'model.example', timeoutSeconds: 600 }],
      limits,
    });
    expect(JSON.parse(sign.mock.calls[0][1].body)).toEqual({ contract: 1 });
    expect(sign).toHaveBeenCalledOnce();
    expect(sign.mock.calls[0][1].path).toBe('/v1/health');
  });
  it('rejects incompatible relay responses and unsafe URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ contract: 2, status: 'ok', modelCall: false }), { status: 200 })),
    );
    await expect(signedHealth(sdk, 'https://relay.example')).rejects.toThrow('Incompatible relay');
    await expect(signedHealth(sdk, 'ftp://localhost')).rejects.toThrow('Relay must use HTTPS');
    await expect(signedHealth(sdk, 'https://user:pass@relay.example')).rejects.toThrow('must not contain credentials');
  });
  it('keeps the Backend URL path in each signed route', async () => {
    const secrets: Record<string, string> = env;
    const relay = createRelayHandler({
      config: env.RELAY_CONFIG,
      secret: ref => secrets[ref],
      mockTranslation: true,
      basePath: '/api/ai-translator',
    });
    const fetched = vi.fn(async (url: URL, options: RequestInit) => relay(new Request(url, options)));
    vi.stubGlobal('fetch', fetched);
    for (const backendUrl of [
      'https://functions.example/api/ai-translator',
      'https://functions.example/api/ai-translator/',
    ])
      expect(await signedHealth(sdk, backendUrl)).toMatchObject({ status: 'ok' });
    const result = await signedTranslate(sdk, 'https://functions.example/api/ai-translator', 'primary', translation());
    expect(result.results).toEqual([{ id: 'f-title', status: 'ok', type: 'text', text: 'Hello [fr example]' }]);
    const paths = ['health', 'health', 'translate'].map(route => `/api/ai-translator/v1/${route}`);
    expect(sign.mock.calls.map(([, request]) => request.path)).toEqual(paths);
    expect(fetched.mock.calls.map(([url]) => String(url))).toEqual(
      paths.map(path => `https://functions.example${path}`),
    );
    for (const backendUrl of [
      'https://functions.example/api//x',
      'https://functions.example/api?x',
      'https://functions.example/a#b',
    ])
      await expect(signedHealth(sdk, backendUrl)).rejects.toThrow('Unexpected relay path');
  });
  it('rejects health that lists providers in another shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              contract: 1,
              status: 'ok',
              modelCall: false,
              providerConfigured: true,
              allowedModels: ['test-model'],
              limits,
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(signedHealth(sdk, 'https://relay.example')).rejects.toThrow('Incompatible relay');
  });
  it('round trips a signed mock translation without a model call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, options: RequestInit) =>
        worker.fetch(
          new Request(url, { ...options, headers: { ...options.headers, origin: 'https://app.example' } }),
          env,
        ),
      ),
    );
    const result = await signedTranslate(sdk, 'https://relay.example', 'primary', translation());
    expect(result).toEqual(translated('Hello [fr example]', 'mock'));
    expect(JSON.parse(sign.mock.calls[0][1].body)).toMatchObject({ provider: 'primary', request: { requestId: 'r1' } });
  });
});

describe('queued requests for the same entry', () => {
  const request = translation({ targetLocale: 'fi' });
  const busy = () => new Response(JSON.stringify({ error: 'concurrency_limit' }), { status: 429 });
  const done = () =>
    new Response(JSON.stringify(translated('Hei')), {
      status: 200,
    });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for an active request and sends the same request again', async () => {
    vi.useFakeTimers();
    const responses = [busy(), busy(), done()];
    const fetcher = vi.fn(async (_url: URL, _options: RequestInit) => {
      const response = responses.shift();
      if (!response) throw new Error('No response left');
      return response;
    });
    vi.stubGlobal('fetch', fetcher);
    const pending = signedTranslate(sdk, 'https://relay.example', 'primary', request);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toEqual(translated('Hei'));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sign).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(call => JSON.parse(String(call[1].body)).request.requestId)).toEqual([
      'r1',
      'r1',
      'r1',
    ]);
  });
  it('stops waiting when the run is cancelled', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: URL, _options: RequestInit) => busy());
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const outcome = expect(
      signedTranslate(sdk, 'https://relay.example', 'primary', request, controller.signal),
    ).rejects.toThrow('Cancelled');
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await outcome;
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('gives up after two minutes of waiting', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const fetcher = vi.fn(async (_url: URL, _options: RequestInit) => busy());
    vi.stubGlobal('fetch', fetcher);
    const outcome = expect(signedTranslate(sdk, 'https://relay.example', 'primary', request)).rejects.toThrow(
      'Relay 429: concurrency_limit',
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await outcome;
    expect(Date.now() - started).toBe(120_000);
  });
  it('does not resend other relay errors', async () => {
    const fetcher = vi.fn(
      async (_url: URL, _options: RequestInit) =>
        new Response(JSON.stringify({ error: 'provider_rate_limited' }), { status: 429 }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(signedTranslate(sdk, 'https://relay.example', 'primary', request)).rejects.toThrow(
      'Relay 429: provider_rate_limited',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('admin-selectable models through the Worker', () => {
  const selectableEnv = {
    ...env,
    RELAY_CONFIG: JSON.stringify({
      appDefinitions: { app: { signingSecretRef: 'APP_SIGNING', spaces: { space: ['primary', 'Admin selects'] } } },
      providers: {
        primary: { baseUrl: 'https://model.example/v1', model: 'test-model', credentialRef: 'MODEL_CREDENTIAL' },
        'Admin selects': {
          baseUrl: 'https://model.example/v1',
          credentialRef: 'MODEL_CREDENTIAL',
          models: { deny: ['*-preview'] },
        },
      },
    }),
  };
  const throughWorker = (upstream: () => Response) =>
    vi.fn(async (url: URL | string, options?: RequestInit) =>
      String(url).startsWith('https://model.example/')
        ? upstream()
        : worker.fetch(new Request(url, { ...options, headers: { ...options?.headers } }), selectableEnv),
    );
  const request = translation({ model: 'chat-small', targetLocale: 'fi' });

  it('reads the selectable health shape and lists permitted models without a model call', async () => {
    const fetcher = throughWorker(
      () => new Response(JSON.stringify({ data: [{ id: 'chat-small' }, { id: 'chat-large-preview' }] })),
    );
    vi.stubGlobal('fetch', fetcher);
    expect((await signedHealth(sdk, 'https://relay.example')).providers).toEqual([
      { alias: 'primary', model: 'test-model', host: 'model.example', timeoutSeconds: 600 },
      { alias: 'Admin selects', host: 'model.example', timeoutSeconds: 600, modelSelection: 'installation' },
    ]);
    expect(await signedModels(sdk, 'https://relay.example', 'Admin selects')).toEqual(['chat-small']);
    expect(JSON.parse(sign.mock.calls[1][1].body)).toEqual({ provider: 'Admin selects' });
    expect(sign.mock.calls[1][1].path).toBe('/v1/models');
    expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/chat/completions'))).toEqual([]);
    await expect(signedModels(sdk, 'https://relay.example', 'primary')).rejects.toMatchObject({
      code: 'model_list_unavailable',
    });
  });
  it('rejects a selectable health entry with a model and a model list with other content', async () => {
    const respond = (body: unknown) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body))),
      );
    respond({
      contract: 1,
      status: 'ok',
      modelCall: false,
      providerConfigured: true,
      providers: [{ alias: 'a', host: 'h', timeoutSeconds: 600, model: 'm', modelSelection: 'installation' }],
      limits,
    });
    await expect(signedHealth(sdk, 'https://relay.example')).rejects.toThrow('Incompatible relay');
    for (const body of [{ models: ['mock'] }, { models: [], data: [] }, { models: 'x' }]) {
      respond(body);
      await expect(signedModels(sdk, 'https://relay.example', 'a')).rejects.toThrow('Incompatible model list');
    }
  });
  it('maps a choice the backend no longer allows to an editor message without retrying another choice', async () => {
    const fetcher = throughWorker(() => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    const rejected = await signedTranslate(sdk, 'https://relay.example', 'Admin selects', {
      ...request,
      model: 'chat-large-preview',
    }).catch(error => error);
    expect(rejected).toBeInstanceOf(RelayError);
    expect(rejected).toMatchObject({ status: 400, code: 'model_not_allowed', message: CHOICE_UNAVAILABLE });
    await expect(signedTranslate(sdk, 'https://relay.example', 'removed', request)).rejects.toThrow(CHOICE_UNAVAILABLE);
    expect(sign).toHaveBeenCalledTimes(2);
  });
});
