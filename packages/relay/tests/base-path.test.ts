import {
  createMemoryUsageGate,
  describeRelayConformance,
  envelope,
  healthBody,
  relayConfig,
  relaySecrets,
  signRequest,
  translated,
} from '@ai-translator-for-contentful/relay-conformance';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayHandler, type RelayConfigDocument, RelayConfigError } from '../src';

const relay = (basePath?: string) =>
  createRelayHandler({
    config: relayConfig() as RelayConfigDocument,
    secret: ref => relaySecrets[ref],
    mockTranslation: true,
    gateFor: () => createMemoryUsageGate(),
    basePath,
  });
// A request signed for `signedPath` and sent to `sentPath`.
async function sent(signedPath: string, sentPath = signedPath, body = healthBody): Promise<Request> {
  const signed = await signRequest({}, body, signedPath);
  return new Request(`https://functions.example${sentPath}`, signed);
}

describeRelayConformance('relay handler beneath a base path', {
  createGates: () => () => createMemoryUsageGate(),
  createHandler: ({ config, secrets, mockTranslation, gateFor }) =>
    createRelayHandler({
      config,
      secret: ref => secrets[ref],
      mockTranslation,
      gateFor,
      basePath: '/api/ai-translator',
    }),
  basePath: '/api/ai-translator',
});

describe('relay base path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves the routes at the root by default', async () => {
    expect((await relay()(await sent('/v1/health'))).status).toBe(200);
    expect((await relay('/')(await sent('/v1/health'))).status).toBe(200);
  });

  it('serves health, models and translation beneath a prefix, signed over the full path', async () => {
    for (const prefix of ['/api/ai-translator', '/functions/ai-translator', '/api/ai-translator/']) {
      const handler = relay(prefix);
      const base = prefix.replace(/\/$/, '');
      expect((await handler(await sent(`${base}/v1/health`))).status).toBe(200);
      const translation = await handler(await sent(`${base}/v1/translate`, undefined, envelope()));
      expect(translation.status).toBe(200);
      expect(await translation.json()).toEqual(translated('rule-1', 'Hello [fi-FI example]', 'mock'));
      // A fixed alias has no model list; reaching that check shows the route matched.
      const models = await handler(await sent(`${base}/v1/models`, undefined, JSON.stringify({ provider: 'primary' })));
      expect(await models.json()).toEqual({ error: 'model_list_unavailable' });
      const preflight = await handler(
        new Request(`https://functions.example${base}/v1/translate`, { method: 'OPTIONS' }),
      );
      expect(preflight.status).toBe(204);
    }
  });

  it('rejects a signature over another path than the one received', async () => {
    const handler = relay('/api/ai-translator');
    // Signed for the internal route, as a client unaware of the prefix would.
    expect((await handler(await sent('/v1/health', '/api/ai-translator/v1/health'))).status).toBe(401);
    // Signed for another installation's prefix.
    expect((await handler(await sent('/api/other/v1/health', '/api/ai-translator/v1/health'))).status).toBe(401);
  });

  it('answers not_found outside the prefix, for adjacent prefixes, and for the bare prefix', async () => {
    const handler = relay('/api/ai-translator');
    for (const path of [
      '/v1/health',
      '/api/v1/health',
      '/api/ai-translator2/v1/health',
      '/api/ai-translatorv1/health',
      '/api/AI-Translator/v1/health',
      '/api/ai-translator',
      '/api/ai-translator/',
      '/api/ai-translator/v1/health/',
      '/api/ai-translator//v1/health',
    ]) {
      const response = await handler(await sent(path));
      expect({ path, status: response.status, body: await response.json() }).toEqual({
        path,
        status: 404,
        body: { error: 'not_found' },
      });
      expect((await handler(new Request(`https://functions.example${path}`, { method: 'OPTIONS' }))).status).toBe(404);
    }
  });

  it('rejects ambiguous base paths when the handler is created', () => {
    for (const basePath of ['api', '//', '/api//x', '/api/../x', '/api/./x', '/api?x=1', '/api#x', '/api%2Fx', '/a b'])
      expect(() => relay(basePath)).toThrow(new RelayConfigError('basePath', 'invalid_base_path'));
  });
});
