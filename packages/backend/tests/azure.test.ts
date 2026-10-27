import {
  type ConformanceInput,
  CUSTOM_HOST_EXPECTATION,
  createMemoryUsageGate,
  describeRelayConformance,
  envelope,
  relayConfig,
  relayInput,
  relaySecrets,
  signRequest,
  translated,
  translationRequest,
} from '@ai-translator-for-contentful/relay-conformance';
import { HttpRequest, InvocationContext } from '@azure/functions';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RelayConfigDocument, RelayConfigError } from '../src';
import { type AzureRelayHandlerOptions, createAzureRelayHandler, relayMethods } from '../src/azure/adapter';
import { tableUsageGates } from '../src/azure/table-gate';
import { type Azurite, startAzurite } from './azurite';
import { appUrl, azureRequest, fromAzure, heldProvider, serveAzure, signedTranslation, until } from './helpers';

const prefix = '/api/ai-translator';
const azureHost = { ...CUSTOM_HOST_EXPECTATION, timeoutSeconds: 220 };

// The consumer's handler: configuration and secrets it already resolved.
function translator(
  { config, secrets, mockTranslation, gateFor }: ConformanceInput,
  change: Partial<AzureRelayHandlerOptions> = {},
) {
  return createAzureRelayHandler({ config, secret: ref => secrets[ref], mockTranslation, gateFor, ...change });
}

const health = (status: number, timeoutSeconds = 220) => ({ status, timeoutSeconds });
async function healthOf(handler: ReturnType<typeof translator>, path = '/v1/health') {
  const response = fromAzure(await handler(await azureRequest(await signRequest({}, undefined, path))));
  const body = (await response.json()) as { providers?: { timeoutSeconds: number }[]; error?: string };
  return { status: response.status, timeoutSeconds: body.providers?.[0].timeoutSeconds, error: body.error };
}

describeRelayConformance('Azure handler with in-memory gate', {
  createGates: () => () => createMemoryUsageGate(),
  createHandler: input => serveAzure(translator(input)),
  host: azureHost,
});

describeRelayConformance('Azure handler beneath an existing route prefix', {
  createGates: () => () => createMemoryUsageGate(),
  createHandler: input => serveAzure(translator(input, { basePath: prefix })),
  host: azureHost,
  basePath: prefix,
});

describe('Azure handler', () => {
  const handler = translator(relayInput(undefined, { gateFor: () => createMemoryUsageGate() }));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('answers other methods and paths with the JSON not_found error', async () => {
    for (const [method, path] of [
      ['GET', '/v1/health'],
      ['POST', '/api/v1/health'],
      ['PUT', '/v1/translate'],
    ]) {
      const response = await handler(new HttpRequest({ method, url: `${appUrl}${path}` }));
      expect(response).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    }
    expect(relayMethods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  });

  it('sends no body with a preflight response', async () => {
    const response = await handler(new HttpRequest({ method: 'OPTIONS', url: `${appUrl}/v1/translate` }));
    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
    expect(response.headers).toMatchObject({ 'access-control-allow-origin': '*' });
  });

  it('rejects a query string, which Functions access keys would need', async () => {
    const request = await azureRequest(await signRequest());
    const withKey = new HttpRequest({
      method: 'POST',
      url: `${request.url}?code=function-key`,
      headers: Object.fromEntries(request.headers),
      body: { bytes: new Uint8Array(await request.arrayBuffer()) },
    });
    expect((await handler(withKey)).status).toBe(401);
  });

  it('accepts a typed configuration object', async () => {
    const typed = translator({ ...relayInput(), config: relayConfig() as unknown as string });
    expect(await healthOf(typed)).toMatchObject(health(200));
  });
});

describe('Azure handler in an existing Function App', () => {
  const input = relayInput(undefined, { mockTranslation: true });
  const handler = translator(input, { basePath: prefix });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('serves signed health, models and translation beneath the route prefix', async () => {
    expect(await healthOf(handler, `${prefix}/v1/health`)).toMatchObject(health(200));
    const models = await handler(
      await azureRequest(await signRequest({}, JSON.stringify({ provider: 'primary' }), `${prefix}/v1/models`)),
    );
    expect(models).toMatchObject({ status: 400, body: '{"error":"model_list_unavailable"}' });
    const translation = fromAzure(
      await handler(await azureRequest(await signedTranslation('r1', 'entry-a', `${prefix}/v1/translate`))),
    );
    expect(translation.status).toBe(200);
    expect(await translation.json()).toEqual(translated('r1', 'Hello [fi-FI example]', 'mock'));
    expect(await healthOf(handler, '/v1/health')).toMatchObject({ status: 404, error: 'not_found' });
    expect(await healthOf(handler, '/api/ai-translator2/v1/health')).toMatchObject({ status: 404 });
  });

  it('verifies the signature over the full path and the unchanged raw body', async () => {
    // Signed for the root route, as a frontend unaware of the prefix would.
    const root = await signRequest();
    const moved = new Request(`https://relay.example${prefix}/v1/health`, root);
    expect(fromAzure(await handler(await azureRequest(moved))).status).toBe(401);
    // Unicode, spacing and key order survive: the signature covers these bytes.
    const body = `{ "extra" : true,\n\t"contract": 1, "note": "Hyvää päivää 🌍 ${' '}" }`;
    expect(
      fromAzure(await handler(await azureRequest(await signRequest({}, body, `${prefix}/v1/health`)))).status,
    ).toBe(200);
    const source = '  Hyvää päivää, maailma 🌍\n';
    const translation = envelope(
      translationRequest({
        fields: [{ id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source }],
      }),
    );
    const response = fromAzure(
      await handler(await azureRequest(await signRequest({}, translation, `${prefix}/v1/translate`))),
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('Hyvää päivää, maailma 🌍');
  });

  it('runs inside a consumer handler that leaves the body unread', async () => {
    const log = vi.fn();
    const wrapped = async (request: HttpRequest, context: InvocationContext) => {
      log(request.method, new URL(request.url).pathname);
      return handler(request, context);
    };
    const context = new InvocationContext({ functionName: 'contentfulTranslator', invocationId: 'test' });
    const request = await azureRequest(await signRequest({}, undefined, `${prefix}/v1/health`));
    expect((await wrapped(request, context)).status).toBe(200);
    expect(log).toHaveBeenCalledWith('POST', `${prefix}/v1/health`);
    const read = await azureRequest(await signRequest({}, undefined, `${prefix}/v1/health`));
    await read.text();
    await expect(handler(read, context)).rejects.toThrow('AI Translator needs the request body unread.');
  });

  it('bounds a body before reading it all', async () => {
    const large = await signRequest({}, JSON.stringify({ contract: 1, text: 'x'.repeat(5000) }), `${prefix}/v1/health`);
    expect((await handler(await azureRequest(large))).status).toBe(413);
  });
});

describe('Azure response budget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults provider deadlines to 220 seconds and lowers them with a shorter response budget', async () => {
    expect(await healthOf(translator(relayInput()))).toMatchObject(health(200, 220));
    expect(await healthOf(translator(relayInput(), { responseSeconds: 100 }))).toMatchObject(health(200, 90));
  });

  it('rejects a provider deadline beyond the budget instead of shortening it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [timeoutSeconds, responseSeconds] of [
      [221, undefined],
      [91, 100],
    ]) {
      const config = relayConfig();
      config.providers.primary.timeoutSeconds = timeoutSeconds;
      expect(await healthOf(translator(relayInput(config), { responseSeconds }))).toMatchObject({
        status: 503,
        error: 'relay_misconfigured',
      });
      expect(error).toHaveBeenLastCalledWith(
        JSON.stringify({
          event: 'relay_config_invalid',
          path: 'providers["primary"].timeoutSeconds',
          reason: 'exceeds_host_limit',
        }),
      );
    }
  });

  it('cannot raise the Azure ceiling or leave no time for the provider', () => {
    for (const responseSeconds of [231, 600, 10, 0, -1, 100.5, Number.NaN])
      expect(() => translator(relayInput(), { responseSeconds })).toThrow(
        new RelayConfigError('responseSeconds', 'invalid_response_seconds'),
      );
    expect(() => translator(relayInput(), { basePath: '/api//ai-translator' })).toThrow(
      new RelayConfigError('basePath', 'invalid_base_path'),
    );
  });

  it('keeps secret refs out of the setting names Azure reserves, and out of the consumer’s', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [ref, reservedNames] of [
      ['WEBSITE_AUTH_SECRET', undefined],
      ['APPLICATIONINSIGHTS_KEY', undefined],
      ['TRANSLATOR_SIGNING', ['TRANSLATOR_*']],
    ] as const) {
      const config = relayConfig() as unknown as RelayConfigDocument;
      config.appDefinitions.app.signingSecretRef = ref;
      const handler = createAzureRelayHandler({ config, secret: () => relaySecrets.APP_SIGNING, reservedNames });
      expect(await healthOf(handler)).toMatchObject({ status: 503 });
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('"reason":"reserved_ref"'));
    }
  });
});

describe('Azure Table gate shared by handlers', () => {
  let azurite: Azurite;
  let tables = 0;
  beforeAll(async () => {
    azurite = await startAzurite();
  });
  afterAll(async () => {
    await azurite.stop();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describeRelayConformance('Azure handler with Table gate on Azurite', {
    createGates: () => tableUsageGates(azurite.table(`relay${++tables}`)),
    createHandler: input => serveAzure(translator(input)),
    host: azureHost,
  });

  it('shares same-entry exclusion and replay state between two instances', async () => {
    const table = azurite.table(`shared${++tables}`);
    // Two workers: separate handlers and gate factories over one table.
    const [first, second] = [1, 2].map(() =>
      translator(relayInput(undefined, { gateFor: tableUsageGates(table) }), { basePath: prefix }),
    );
    const provider = heldProvider();
    const replayed = await signedTranslation('a1', 'entry-a', `${prefix}/v1/translate`);
    const pending = first(await azureRequest(replayed.clone()));
    await until(() => provider.fetcher.mock.calls.length === 1);
    expect(
      await second(await azureRequest(await signedTranslation('b1', 'entry-a', `${prefix}/v1/translate`))),
    ).toMatchObject({
      status: 429,
      body: '{"error":"concurrency_limit"}',
    });
    const other = second(await azureRequest(await signedTranslation('c1', 'entry-b', `${prefix}/v1/translate`)));
    await until(() => provider.fetcher.mock.calls.length === 2);
    provider.answer();
    expect((await pending).status).toBe(200);
    expect((await other).status).toBe(200);
    expect(await second(await azureRequest(replayed))).toMatchObject({
      status: 429,
      body: '{"error":"duplicate_request"}',
    });
    const next = fromAzure(
      await second(await azureRequest(await signedTranslation('a2', 'entry-a', `${prefix}/v1/translate`))),
    );
    expect(await next.json()).toEqual(translated('a2', 'Hei'));
  });
});
