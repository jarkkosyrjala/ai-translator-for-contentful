import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  healthBody as body,
  type ConformanceConfig,
  type ConformanceGate,
  type ConformanceInput,
  completion,
  conformanceScope,
  envelope,
  relayConfig,
  relayInput,
  relaySecrets,
  signRequest,
  translated,
  translationRequest,
} from './fixtures';

// What health reports for this host's defaults.
export type HostExpectation = {
  timeoutSeconds: number;
  limits: { requestBytes: number; providerBodyBytes: number; resultBytes: number };
};
const MiB = 1_048_576;
export const CUSTOM_HOST_EXPECTATION: HostExpectation = {
  timeoutSeconds: 600,
  limits: { requestBytes: 2 * MiB, providerBodyBytes: 4 * MiB, resultBytes: 4 * MiB },
};

export type RelayConformanceTarget = {
  // A fresh store for the host's own usage gate. The returned function gives
  // the gate of one verified scope.
  createGates(): (scope: string) => ConformanceGate;
  // The host's HTTP entry point configured with this relay configuration.
  createHandler(input: ConformanceInput): (request: Request) => Promise<Response>;
  // The host's health defaults; omitted for hosts with the custom defaults.
  host?: HostExpectation;
  // The path the handler serves the routes beneath, as its basePath; requests
  // are signed for the full path. Omitted for the root.
  basePath?: string;
};

const second = 'Self-hosted model';
const appBSecret = 'd'.repeat(64);

// Two App Definitions. One space allows two providers, another allows one, and
// the second App Definition reuses a provider and lists one of the same spaces.
function sharedConfig(): ConformanceConfig {
  const config = relayConfig();
  config.appDefinitions.app.spaces = { space: ['primary', second], 'space-two': [second] };
  config.appDefinitions['app-b'] = {
    signingSecretRef: 'APP_B_SIGNING',
    spaces: { 'space-three': ['primary'], space: ['primary'] },
  };
  config.providers[second] = {
    baseUrl: 'https://another-model.example/v1',
    model: 'another-model',
    authMode: 'bearer',
    credentialRef: 'SECOND_MODEL_CREDENTIAL',
  };
  return config;
}
const sharedSecrets = { ...relaySecrets, APP_B_SIGNING: appBSecret, SECOND_MODEL_CREDENTIAL: 'second-key' };

const selectable = 'Admin selects';
// The space also allows an alias whose models the installation chooses, at the
// first provider's endpoint and credential. The deployer excludes one exact ID
// and a wildcard family. `space-two` does not list it.
function selectableConfig(models: Record<string, unknown> = { deny: ['premium-model', '*-pro*'] }): ConformanceConfig {
  const config = sharedConfig();
  config.appDefinitions.app.spaces.space.push(selectable);
  config.providers[selectable] = {
    baseUrl: 'https://model.example/v1',
    authMode: 'bearer',
    credentialRef: 'MODEL_CREDENTIAL',
    models,
  };
  return config;
}

// Mandatory remote-relay behavior. Every HTTP host runs this suite against its
// adapter; see docs/backend-contract.md for the rule each case covers.
export function describeRelayConformance(name: string, target: RelayConformanceTarget): void {
  const host = target.host ?? CUSTOM_HOST_EXPECTATION;
  const base = target.basePath ?? '';
  const at = (path: string) => `https://relay.example${base}${path}`;
  const signedRequest = (
    overrides?: Record<string, string>,
    requestBody?: string,
    path = '/v1/health',
    secret?: string,
  ): Promise<Request> => signRequest(overrides, requestBody, `${base}${path}`, secret);
  const listed = (alias: string, model: string, hostname: string) => ({
    alias,
    host: hostname,
    timeoutSeconds: host.timeoutSeconds,
    model,
  });
  const later = () => Date.now() + 60_000;
  const serve = (request: Request, input: ConformanceInput = relayInput()) => target.createHandler(input)(request);
  const jsonOf = async (response: Response) => (await response.json()) as { error?: string; providers?: unknown[] };
  const errorOf = async (response: Response) => ({ status: response.status, body: await jsonOf(response) });
  const withHeaders = (request: Request, change: (headers: Headers) => void) => {
    const headers = new Headers(request.headers);
    change(headers);
    return new Request(request, { headers });
  };
  const replying = (content = 'Hei') => vi.fn(async (..._args: Parameters<typeof fetch>) => completion(content));
  // One gate per scope, created on first use, so tests can hold or spy on it.
  function gateStore() {
    const create = target.createGates();
    const gates = new Map<string, ConformanceGate>();
    const get = (scope: string) => {
      let gate = gates.get(scope);
      if (!gate) {
        gate = create(scope);
        gates.set(scope, gate);
      }
      return gate;
    };
    return { get, gateFor: vi.fn(get) };
  }
  const translate = (request: Record<string, unknown> = translationRequest(), provider = 'primary') =>
    signedRequest({}, envelope(request, provider), '/v1/translate');
  const listModels = (provider: string, headers: Record<string, string> = {}) =>
    signedRequest(headers, JSON.stringify({ provider }), '/v1/models');
  const catalog = (ids: string[]) =>
    vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({ data: ids.map(id => ({ id })) })),
    );

  describe(`relay conformance: ${name}`, () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('accepts valid request and returns safe contract metadata', async () => {
      const response = await serve(await signedRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        contract: 1,
        status: 'ok',
        modelCall: false,
        providerConfigured: false,
        providers: [listed('primary', 'test-model', 'model.example')],
        limits: host.limits,
      });
    });
    it('rejects an unlisted space, stale timestamp, and tampered body', async () => {
      expect((await serve(await signedRequest({ 'x-contentful-space-id': 'other' }))).status).toBe(401);
      expect((await serve(await signedRequest({ 'x-contentful-timestamp': String(Date.now() - 120000) }))).status).toBe(
        401,
      );
      const original = await signedRequest();
      expect((await serve(new Request(original, { body: '{"contract":1,"note":"tampered"}' }))).status).toBe(401);
      const request = await signedRequest();
      const headers = new Headers(request.headers);
      headers.set('x-contentful-user-id', 'other');
      expect((await serve(new Request(request, { headers }))).status).toBe(401);
    });
    it('accepts any signed environment of a listed space, such as a clone', async () => {
      const response = await serve(await signedRequest({ 'x-contentful-environment-id': 'staging-clone' }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ providers: [{ alias: 'primary' }] });
    });
    it('accepts the previous signing key during rotation and rejects an unrelated key', async () => {
      const config = relayConfig();
      config.appDefinitions.app.previousSigningSecretRef = 'APP_SIGNING_PREVIOUS';
      const rotating = relayInput(config, { secrets: { ...relaySecrets, APP_SIGNING_PREVIOUS: 'b'.repeat(64) } });
      expect((await serve(await signedRequest({}, body, '/v1/health', 'b'.repeat(64)), rotating)).status).toBe(200);
      expect(
        (await serve(await signedRequest({}, body, '/v1/health', relaySecrets.APP_SIGNING), rotating)).status,
      ).toBe(200);
      expect((await serve(await signedRequest({}, body, '/v1/health', 'c'.repeat(64)), rotating)).status).toBe(401);
    });
    it('keeps the translation route disabled without a usage gate unless mock translation is on', async () => {
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      const payload = translationRequest({
        requestId: 'r1',
        targetLocale: 'fr-FR',
        availableLocales: ['en-US', 'fr-FR'],
      });
      expect(await errorOf(await serve(await translate(payload)))).toEqual({
        status: 503,
        body: { error: 'translation_not_enabled' },
      });
      const response = await serve(await translate(payload), relayInput(undefined, { mockTranslation: true }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(translated('r1', 'Hello [fr-FR example]', 'mock'));
      expect(fetcher).not.toHaveBeenCalled();
    });
    it('rejects other contracts so the app asks for a backend update', async () => {
      const mock = relayInput(undefined, { mockTranslation: true });
      for (const contract of [0, 2])
        expect(await errorOf(await serve(await translate(translationRequest({ contract })), mock))).toEqual({
          status: 400,
          body: { error: 'unsupported_contract' },
        });
      for (const contract of [0, 2])
        expect(await errorOf(await serve(await signedRequest({}, JSON.stringify({ contract })), mock))).toEqual({
          status: 400,
          body: { error: 'unsupported_contract' },
        });
    });
    it('rejects an oversize body', async () => {
      const huge = await signedRequest({}, JSON.stringify({ contract: 1, text: 'x'.repeat(5000) }));
      expect((await serve(huge)).status).toBe(413);
    });
    it('accepts a signed request from any origin or without Origin', async () => {
      for (const origin of ['https://other.example', 'http://localhost:3000', undefined]) {
        const request = await signedRequest();
        const headers = new Headers(request.headers);
        if (origin) headers.set('origin', origin);
        else headers.delete('origin');
        const response = await serve(new Request(request, { headers }));
        expect(response.status).toBe(200);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      }
    });
    it('calls a configured provider only after a usage reservation and releases it', async () => {
      const gates = gateStore();
      const gate = gates.get(await conformanceScope('app', 'space', 'master'));
      const reserve = vi.spyOn(gate, 'reserve');
      const release = vi.spyOn(gate, 'release');
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      const paid = relayInput(undefined, { gateFor: gates.gateFor });
      const response = await serve(await translate(translationRequest({ requestId: 'paid-1' })), paid);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(translated('paid-1', 'Hei'));
      expect(reserve).toHaveBeenCalledWith('entry-a', 'paid-1', expect.any(Number));
      expect(release).toHaveBeenCalledWith('paid-1');
      expect(fetcher.mock.calls[0][0].toString()).toBe('https://model.example/v1/chat/completions');
      expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer server-only-key' });
      // Another in-flight request for the same entry makes the gate refuse the next one.
      expect(await gate.reserve('entry-a', 'in-flight', later())).toEqual({ ok: true });
      expect((await serve(await translate(translationRequest({ requestId: 'paid-2' })), paid)).status).toBe(429);
      expect(fetcher).toHaveBeenCalledOnce();
    });
    it('accepts an explicitly unauthenticated provider with request options', async () => {
      const config = relayConfig();
      config.providers.primary = {
        baseUrl: 'https://model.example/v1',
        model: 'test-model',
        authMode: 'none',
        options: { temperature: 0.1 },
      };
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      const gates = gateStore();
      expect(
        (await serve(await translate(translationRequest({ requestId: 'no-auth-1' })), relayInput(config, gates)))
          .status,
      ).toBe(200);
      expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('authorization');
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
        model: 'test-model',
        temperature: 0.1,
      });
    });
    it('answers relay_misconfigured for an invalid configuration before verifying signatures', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      const change = (edit: (config: ConformanceConfig) => void) => {
        const config = sharedConfig();
        edit(config);
        return config;
      };
      const invalid: Array<[string, ConformanceConfig | string, Record<string, string>?]> = [
        ['missing', ''],
        ['malformed JSON', '{"appDefinitions":'],
        ['unexpected property', change(config => Object.assign(config, { allowedModels: ['test-model'] }))],
        ['non-boolean debug', change(config => Object.assign(config, { debug: 'true' }))],
        [
          'HTTP provider',
          change(config => Object.assign(config.providers.primary, { baseUrl: 'http://model.example' })),
        ],
        [
          'provider URL with a query',
          change(config => Object.assign(config.providers.primary, { baseUrl: 'https://model.example/v1?key=x' })),
        ],
        [
          'reserved body option',
          change(config => Object.assign(config.providers.primary, { options: { extraBody: { model: 'override' } } })),
        ],
        ['unresolved credential', change(config => Object.assign(config.providers.primary, { credentialRef: 'NONE' }))],
        ['empty signing secret', sharedConfig(), { ...sharedSecrets, APP_SIGNING: '' }],
        [
          'reserved ref',
          change(config => Object.assign(config.appDefinitions.app, { signingSecretRef: 'RELAY_CONFIG' })),
        ],
        [
          'invalid ref',
          change(config => Object.assign(config.appDefinitions.app, { signingSecretRef: 'app-signing' })),
        ],
        [
          'fixed and selectable model',
          change(config => Object.assign(config.providers.primary, { models: { deny: ['x'] } })),
        ],
        [
          'malformed model pattern',
          change(config => {
            const { model: _model, ...rest } = config.providers.primary;
            config.providers.primary = { ...rest, models: { deny: ['bad pattern'] } };
          }),
        ],
        [
          'non-array model allow list',
          change(config => {
            const { model: _model, ...rest } = config.providers.primary;
            config.providers.primary = { ...rest, models: { allow: 'chat-*' } };
          }),
        ],
        [
          'timeout above the host bound',
          change(config => Object.assign(config.providers.primary, { timeoutSeconds: 100_000 })),
        ],
        [
          'idle timeout above the timeout',
          change(config => Object.assign(config.providers.primary, { timeoutSeconds: 30, idleTimeoutSeconds: 31 })),
        ],
        ['fractional timeout', change(config => Object.assign(config.providers.primary, { timeoutSeconds: 1.5 }))],
        ['limit above the host bound', change(config => Object.assign(config, { limits: { requestBytes: 2 ** 40 } }))],
        ['unknown limit', change(config => Object.assign(config, { limits: { pages: 1 } }))],
        ['unknown provider alias', change(config => config.appDefinitions.app.spaces.space.push('missing'))],
        ['repeated provider alias', change(config => config.appDefinitions.app.spaces.space.push('primary'))],
        ['empty provider list', change(config => Object.assign(config.appDefinitions.app.spaces, { space: [] }))],
        ['blank provider alias', change(config => Object.assign(config.providers, { ' ': config.providers.primary }))],
        ['blank space ID', change(config => Object.assign(config.appDefinitions.app.spaces, { '': ['primary'] }))],
        [
          'shared current signing secret',
          change(config => Object.assign(config.appDefinitions['app-b'], { signingSecretRef: 'APP_SIGNING' })),
        ],
        [
          'shared previous signing secret',
          change(config =>
            Object.assign(config.appDefinitions['app-b'], { previousSigningSecretRef: 'APP_SIGNING_OLD' }),
          ),
          { ...sharedSecrets, APP_SIGNING_OLD: relaySecrets.APP_SIGNING },
        ],
      ];
      for (const [label, config, secrets = sharedSecrets] of invalid) {
        const gates = gateStore();
        const input = relayInput(config, { secrets, gateFor: gates.gateFor, mockTranslation: true });
        for (const request of [
          await signedRequest(),
          await translate(),
          new Request(at('/v1/health'), { method: 'POST', body }),
        ])
          expect({ label, ...(await errorOf(await serve(request, input))) }).toEqual({
            label,
            status: 503,
            body: { error: 'relay_misconfigured' },
          });
        expect(gates.gateFor).not.toHaveBeenCalled();
      }
      expect(fetcher).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"relay_config_invalid"'));
      expect(JSON.stringify(log.mock.calls)).not.toContain(relaySecrets.APP_SIGNING);
      expect(JSON.stringify(log.mock.calls)).not.toContain(relaySecrets.MODEL_CREDENTIAL);
    });
    it('lists only the providers the calling space allows', async () => {
      const input = relayInput(sharedConfig(), { secrets: sharedSecrets });
      const providers = async (request: Request) => (await jsonOf(await serve(request, input))).providers;
      expect(await providers(await signedRequest())).toEqual([
        listed('primary', 'test-model', 'model.example'),
        listed(second, 'another-model', 'another-model.example'),
      ]);
      expect(await providers(await signedRequest({ 'x-contentful-space-id': 'space-two' }))).toEqual([
        listed(second, 'another-model', 'another-model.example'),
      ]);
      expect(
        await providers(
          await signedRequest({ 'x-contentful-space-id': 'space-three' }, body, '/v1/health', appBSecret),
        ),
      ).toEqual([listed('primary', 'test-model', 'model.example')]);
    });
    it('routes each allowed provider to its configured endpoint, model, and credential', async () => {
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      const gates = gateStore();
      const input = relayInput(sharedConfig(), { secrets: sharedSecrets, gateFor: gates.gateFor });
      const sent = (call: number) => ({
        url: String(fetcher.mock.calls[call][0]),
        authorization: (fetcher.mock.calls[call][1]?.headers as Record<string, string> | undefined)?.authorization,
        model: JSON.parse(String(fetcher.mock.calls[call][1]?.body)).model,
      });
      expect((await serve(await translate(translationRequest({ requestId: 'p1' })), input)).status).toBe(200);
      expect(
        (await serve(await translate(translationRequest({ requestId: 'p2', model: 'another-model' }), second), input))
          .status,
      ).toBe(200);
      expect(
        (
          await serve(
            await signedRequest(
              { 'x-contentful-space-id': 'space-three' },
              envelope(translationRequest({ requestId: 'p3' })),
              '/v1/translate',
              appBSecret,
            ),
            input,
          )
        ).status,
      ).toBe(200);
      expect([sent(0), sent(1), sent(2)]).toEqual([
        {
          url: 'https://model.example/v1/chat/completions',
          authorization: 'Bearer server-only-key',
          model: 'test-model',
        },
        {
          url: 'https://another-model.example/v1/chat/completions',
          authorization: 'Bearer second-key',
          model: 'another-model',
        },
        {
          url: 'https://model.example/v1/chat/completions',
          authorization: 'Bearer server-only-key',
          model: 'test-model',
        },
      ]);
    });
    it('identifies the App Definition by the signing secret that verifies the request', async () => {
      vi.stubGlobal('fetch', replying());
      const config = sharedConfig();
      config.appDefinitions['app-b'].previousSigningSecretRef = 'APP_B_PREVIOUS';
      const gates = gateStore();
      const input = relayInput(config, {
        secrets: { ...sharedSecrets, APP_B_PREVIOUS: 'e'.repeat(64) },
        gateFor: gates.gateFor,
      });
      // `space` is listed under both definitions with different provider lists.
      const health = async (secret: string, space = 'space') =>
        errorOf(
          await serve(await signedRequest({ 'x-contentful-space-id': space }, body, '/v1/health', secret), input),
        );
      expect((await health(relaySecrets.APP_SIGNING)).body.providers).toHaveLength(2);
      expect((await health(appBSecret)).body.providers).toEqual([listed('primary', 'test-model', 'model.example')]);
      expect((await health('e'.repeat(64))).body.providers).toHaveLength(1);
      // A secret of one definition does not verify a space only the other lists.
      expect(await health(appBSecret, 'space-two')).toEqual({ status: 401, body: { error: 'invalid_signature' } });
      expect(await health(relaySecrets.APP_SIGNING, 'space-three')).toEqual({
        status: 401,
        body: { error: 'invalid_signature' },
      });
      for (const [secret, requestId] of [
        [relaySecrets.APP_SIGNING, 'by-app'],
        [appBSecret, 'by-app-b'],
      ])
        expect(
          (
            await serve(
              await signedRequest({}, envelope(translationRequest({ requestId })), '/v1/translate', secret),
              input,
            )
          ).status,
        ).toBe(200);
      expect(gates.gateFor.mock.calls).toEqual([
        [await conformanceScope('app', 'space', 'master')],
        [await conformanceScope('app-b', 'space', 'master')],
      ]);
    });
    it('rejects unlisted providers, mismatched models, and tampered envelopes before any provider call', async () => {
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      const gates = gateStore();
      const input = relayInput(sharedConfig(), { secrets: sharedSecrets, gateFor: gates.gateFor });
      expect(await errorOf(await serve(await translate(translationRequest(), 'missing'), input))).toEqual({
        status: 400,
        body: { error: 'provider_not_allowed' },
      });
      expect(await errorOf(await serve(await translate(translationRequest(), 'constructor'), input))).toEqual({
        status: 400,
        body: { error: 'provider_not_allowed' },
      });
      expect(
        await errorOf(
          await serve(
            await signedRequest({ 'x-contentful-space-id': 'space-two' }, envelope(), '/v1/translate'),
            input,
          ),
        ),
      ).toEqual({ status: 400, body: { error: 'provider_not_allowed' } });
      expect(
        await errorOf(await serve(await translate(translationRequest({ model: 'another-model' })), input)),
      ).toEqual({ status: 400, body: { error: 'model_not_allowed' } });
      const signed = await translate();
      expect(
        await errorOf(
          await serve(
            new Request(signed, { body: envelope(translationRequest({ model: 'another-model' }), second) }),
            input,
          ),
        ),
      ).toEqual({ status: 401, body: { error: 'invalid_signature' } });
      expect(
        await errorOf(await serve(await signedRequest({}, envelope(), '/v1/translate', 'c'.repeat(64)), input)),
      ).toEqual({ status: 401, body: { error: 'invalid_signature' } });
      expect(gates.gateFor).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });
    it('answers mock translation only for a listed provider and its model', async () => {
      const input = relayInput(sharedConfig(), { secrets: sharedSecrets, mockTranslation: true });
      expect((await serve(await translate(), input)).status).toBe(200);
      expect((await serve(await translate(translationRequest({ model: 'another-model' }), second), input)).status).toBe(
        200,
      );
      expect(await errorOf(await serve(await translate(translationRequest(), 'missing'), input))).toEqual({
        status: 400,
        body: { error: 'provider_not_allowed' },
      });
      expect(
        await errorOf(await serve(await translate(translationRequest({ model: 'another-model' })), input)),
      ).toEqual({ status: 400, body: { error: 'model_not_allowed' } });
    });
    it('reserves equal entry IDs separately per verified environment, space, and App Definition', async () => {
      vi.stubGlobal('fetch', replying());
      const gates = gateStore();
      const input = relayInput(sharedConfig(), { secrets: sharedSecrets, gateFor: gates.gateFor });
      const held = await conformanceScope('app', 'space', 'master');
      expect(await gates.get(held).reserve('entry-a', 'held', later())).toEqual({ ok: true });
      const request = translationRequest({ requestId: 'same-request' });
      expect(await errorOf(await serve(await translate(request), input))).toEqual({
        status: 429,
        body: { error: 'concurrency_limit' },
      });
      for (const signed of [
        await signedRequest({ 'x-contentful-environment-id': 'staging' }, envelope(request), '/v1/translate'),
        await signedRequest(
          { 'x-contentful-space-id': 'space-two' },
          envelope({ ...request, model: 'another-model' }, second),
          '/v1/translate',
        ),
        await signedRequest({}, envelope(request), '/v1/translate', appBSecret),
      ])
        expect((await serve(signed, input)).status).toBe(200);
      expect(gates.gateFor.mock.calls).toEqual([
        [held],
        [await conformanceScope('app', 'space', 'staging')],
        [await conformanceScope('app', 'space-two', 'master')],
        [await conformanceScope('app-b', 'space', 'master')],
      ]);
    });
    it('serves only POST /v1/health, /v1/translate and /v1/models and answers their preflight', async () => {
      const signed = await signedRequest();
      expect(await errorOf(await serve(new Request(at('/v1/health'), { method: 'GET' })))).toEqual({
        status: 404,
        body: { error: 'not_found' },
      });
      expect(
        await errorOf(await serve(new Request(at('/v1/other'), { method: 'POST', headers: signed.headers, body }))),
      ).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(
        (
          await serve(
            new Request(at('/v1/other'), {
              method: 'OPTIONS',
              headers: { origin: 'https://relay.example' },
            }),
          )
        ).status,
      ).toBe(404);
      for (const path of ['/v1/translate', '/v1/models'])
        expect(
          (
            await serve(
              new Request(at(path), {
                method: 'OPTIONS',
                headers: { origin: 'https://relay.example' },
              }),
            )
          ).status,
        ).toBe(204);
      expect(await errorOf(await serve(new Request(at('/v1/models'), { method: 'GET' })))).toEqual({
        status: 404,
        body: { error: 'not_found' },
      });
    });
    it('returns wildcard CORS headers while requiring a valid signature for POST', async () => {
      const preflight = await serve(
        new Request(at('/v1/health'), {
          method: 'OPTIONS',
          headers: { origin: 'https://other.example' },
        }),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
      expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type, X-Contentful-Signature, X-Contentful-Signed-Headers, X-Contentful-Timestamp, X-Contentful-Space-Id, X-Contentful-Environment-Id, X-Contentful-User-Id, X-Contentful-CRN',
      );
      expect(preflight.headers.get('Vary')).toBeNull();
      const unsigned = await serve(
        new Request(at('/v1/health'), {
          method: 'POST',
          headers: { origin: 'https://other.example', 'content-type': 'application/json' },
          body,
        }),
      );
      expect(await errorOf(unsigned)).toEqual({ status: 401, body: { error: 'invalid_signature' } });
      expect(unsigned.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
    it('rejects incomplete or malformed signatures', async () => {
      const rejected = async (request: Request) =>
        expect(await errorOf(await serve(request))).toEqual({ status: 401, body: { error: 'invalid_signature' } });
      await rejected(withHeaders(await signedRequest(), headers => headers.delete('x-contentful-signature')));
      await rejected(withHeaders(await signedRequest(), headers => headers.set('x-contentful-signature', 'not-hex')));
      await rejected(await signedRequest({ 'x-contentful-environment-id': '' }));
      await rejected(await signedRequest({ 'x-contentful-timestamp': String(Date.now() + 120000) }));
      await rejected(await signedRequest({ 'x-contentful-timestamp': 'yesterday' }));
      await rejected(
        await signedRequest({
          'x-contentful-signed-headers':
            'content-type,x-contentful-environment-id,x-contentful-signed-headers,x-contentful-space-id,x-contentful-timestamp',
        }),
      );
      await rejected(
        await signedRequest({
          'x-contentful-signed-headers':
            'content-type,content-type,x-contentful-environment-id,x-contentful-signed-headers,x-contentful-space-id,x-contentful-timestamp,x-contentful-user-id',
        }),
      );
      await rejected(
        await signedRequest({
          'x-contentful-signed-headers':
            'Content-Type,x-contentful-environment-id,x-contentful-signed-headers,x-contentful-space-id,x-contentful-timestamp,x-contentful-user-id',
        }),
      );
      await rejected(
        await signedRequest({
          'x-contentful-signed-headers':
            'content-type,x-contentful-crn,x-contentful-environment-id,x-contentful-signed-headers,x-contentful-space-id,x-contentful-timestamp,x-contentful-user-id',
        }),
      );
      await rejected(
        await signedRequest({
          'x-contentful-signed-headers':
            'content-type,,x-contentful-environment-id,x-contentful-signed-headers,x-contentful-space-id,x-contentful-timestamp,x-contentful-user-id',
        }),
      );
      await rejected(
        await signedRequest({
          'x-contentful-signed-headers':
            'content-type,x(y),x-contentful-environment-id,x-contentful-signed-headers,x-contentful-space-id,x-contentful-timestamp,x-contentful-user-id',
        }),
      );
      await rejected(withHeaders(await signedRequest(), headers => headers.delete('x-contentful-user-id')));
      const signed = await signedRequest();
      await rejected(new Request(at('/v1/health?check=1'), { method: 'POST', headers: signed.headers, body }));
    });
    it('bounds request bodies and requires UTF-8 JSON', async () => {
      const atLimit = JSON.stringify({ contract: 1, pad: '' }).length;
      expect(
        (await serve(await signedRequest({}, JSON.stringify({ contract: 1, pad: 'x'.repeat(4096 - atLimit) })))).status,
      ).toBe(200);
      expect(
        await errorOf(
          await serve(
            await signedRequest({}, 'x'.repeat(host.limits.requestBytes + 1), '/v1/translate'),
            relayInput(undefined, { mockTranslation: true }),
          ),
        ),
      ).toEqual({ status: 413, body: { error: 'too_large' } });
      const small = relayConfig() as ConformanceConfig & { limits?: unknown };
      small.limits = { requestBytes: 2_000 };
      expect(
        await errorOf(
          await serve(
            await translate(
              translationRequest({
                fields: [{ id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source: 'x'.repeat(2_000) }],
              }),
            ),
            relayInput(small, { mockTranslation: true }),
          ),
        ),
      ).toEqual({ status: 413, body: { error: 'too_large' } });
      const signed = await signedRequest();
      expect(
        await errorOf(
          await serve(
            new Request(at('/v1/health'), {
              method: 'POST',
              headers: signed.headers,
              body: new Uint8Array([0x7b, 0xff, 0x7d]),
            }),
          ),
        ),
      ).toEqual({ status: 400, body: { error: 'invalid_encoding' } });
      expect(await errorOf(await serve(await signedRequest({}, '{bad')))).toEqual({
        status: 400,
        body: { error: 'invalid_json' },
      });
    });
    it('negotiates health contract 1 without a model call', async () => {
      const fetcher = vi.fn(async () => new Response('{}'));
      vi.stubGlobal('fetch', fetcher);
      expect(await errorOf(await serve(await signedRequest({}, JSON.stringify({ contract: 9 }))))).toEqual({
        status: 400,
        body: { error: 'unsupported_contract' },
      });
      expect(await (await serve(await signedRequest(), relayInput(undefined, gateStore()))).json()).toEqual({
        contract: 1,
        status: 'ok',
        modelCall: false,
        providerConfigured: true,
        providers: [listed('primary', 'test-model', 'model.example')],
        limits: host.limits,
      });
      const tuned = relayConfig() as ConformanceConfig & { limits?: unknown };
      tuned.providers.primary.timeoutSeconds = 45;
      tuned.providers.primary.options = { maxCompletionTokens: 8_192 };
      tuned.limits = { resultBytes: 100_000 };
      expect(await (await serve(await signedRequest(), relayInput(tuned))).json()).toMatchObject({
        providers: [{ alias: 'primary', timeoutSeconds: 45, maxCompletionTokens: 8_192 }],
        limits: { resultBytes: 100_000 },
      });
      expect(await (await serve(await signedRequest())).json()).toMatchObject({ providerConfigured: false });
      expect(fetcher).not.toHaveBeenCalled();
    });
    it('rejects invalid translation requests with stable codes', async () => {
      const mock = relayInput(undefined, { mockTranslation: true });
      const rejected = async (requestBody: string, status: number, error: string, headers = {}) =>
        expect(await errorOf(await serve(await signedRequest(headers, requestBody, '/v1/translate'), mock))).toEqual({
          status,
          body: { error },
        });
      await rejected(envelope(), 415, 'invalid_content_type', { 'content-type': 'text/plain' });
      await rejected(JSON.stringify(translationRequest()), 400, 'unexpected_property');
      await rejected(
        JSON.stringify({ provider: 'primary', request: translationRequest(), extra: true }),
        400,
        'unexpected_property',
      );
      await rejected(JSON.stringify({ request: translationRequest() }), 400, 'invalid_request');
      await rejected(JSON.stringify({ provider: 1, request: translationRequest() }), 400, 'invalid_request');
      await rejected(JSON.stringify({ provider: 'primary' }), 400, 'invalid_request');
      await rejected(JSON.stringify([]), 400, 'invalid_request');
      await rejected(envelope(translationRequest({ extra: true })), 400, 'unexpected_property');
      await rejected(envelope(translationRequest({ targetLocale: 'en-US' })), 400, 'same_locale');
      await rejected(envelope(translationRequest({ contract: 2 })), 400, 'unsupported_contract');
      await rejected(envelope(translationRequest({ fields: [] })), 400, 'invalid_request');
      await rejected(
        envelope(
          translationRequest({
            fields: [{ id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source: '' }],
          }),
        ),
        400,
        'invalid_request',
      );
      await rejected(envelope(translationRequest({ entryId: undefined })), 400, 'invalid_request');
      await rejected(envelope(translationRequest({ model: 'other-model' })), 400, 'model_not_allowed');
      await rejected(envelope(translationRequest({ profileRevision: 'other-revision' })), 400, 'invalid_request');
    });
    it('enforces the provider model and usage gate before a provider call', async () => {
      const gates = gateStore();
      const gate = gates.get(await conformanceScope('app', 'space', 'master'));
      const reserve = vi.spyOn(gate, 'reserve');
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      const paid = relayInput(undefined, { gateFor: gates.gateFor });
      expect(await errorOf(await serve(await translate(translationRequest({ model: 'other-model' })), paid))).toEqual({
        status: 400,
        body: { error: 'model_not_allowed' },
      });
      expect(await errorOf(await serve(await translate()))).toEqual({
        status: 503,
        body: { error: 'translation_not_enabled' },
      });
      expect(reserve).not.toHaveBeenCalled();
      expect((await serve(await translate(), paid)).status).toBe(200);
      expect(await errorOf(await serve(await translate(), paid))).toEqual({
        status: 429,
        body: { error: 'duplicate_request' },
      });
      expect(fetcher).toHaveBeenCalledOnce();
    });
    it('rejects a busy request before reserving it so the same request can be retried', async () => {
      const gates = gateStore();
      const gate = gates.get(await conformanceScope('app', 'space', 'master'));
      vi.stubGlobal('fetch', replying());
      const paid = relayInput(undefined, { gateFor: gates.gateFor });
      expect(await gate.reserve('entry-a', 'earlier', later())).toEqual({ ok: true });
      expect(await errorOf(await serve(await translate(translationRequest({ requestId: 'queued' })), paid))).toEqual({
        status: 429,
        body: { error: 'concurrency_limit' },
      });
      await gate.release('earlier');
      const retried = await serve(await translate(translationRequest({ requestId: 'queued' })), paid);
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual(translated('queued', 'Hei'));
    });
    it('maps provider failures to safe error codes and releases the reservation', async () => {
      const gates = gateStore();
      const gate = gates.get(await conformanceScope('app', 'space', 'master'));
      const release = vi.spyOn(gate, 'release');
      const paid = relayInput(undefined, { gateFor: gates.gateFor });
      const detail = 'upstream-detail-with-server-only-key';
      const failures: Array<[() => Response, number, string]> = [
        [() => new Response(detail, { status: 429 }), 429, 'provider_rate_limited'],
        [() => new Response(detail, { status: 500 }), 502, 'provider_failed'],
        [() => new Response(detail, { status: 401 }), 502, 'provider_auth_failed'],
        [() => new Response(detail, { status: 413 }), 413, 'provider_request_too_large'],
        [
          () => new Response(`{"error":{"code":"context_length_exceeded","message":"${detail}"}}`, { status: 400 }),
          413,
          'provider_request_too_large',
        ],
        [() => new Response(detail, { status: 200 }), 502, 'invalid_provider_response'],
        [() => completion('Hei', 'length'), 502, 'provider_truncated'],
        [() => completion('Hei', 'content_filter'), 502, 'provider_refused'],
        [
          () =>
            new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\n', {
              headers: { 'content-type': 'text/event-stream' },
            }),
          502,
          'provider_incomplete',
        ],
        [() => completion(`${detail}</field></field>`), 502, 'invalid_provider_response'],
        [
          () => {
            throw Object.assign(new Error(detail), { name: 'TypeError' });
          },
          502,
          'provider_failed',
        ],
      ];
      for (const [index, [upstream, status, error]] of failures.entries()) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => upstream()),
        );
        const response = await serve(await translate(translationRequest({ requestId: `failure-${index}` })), paid);
        const text = await response.text();
        expect({ status: response.status, body: JSON.parse(text) }).toEqual({ status, body: { error } });
        expect(text).not.toContain('upstream-detail');
        expect(release).toHaveBeenLastCalledWith(`failure-${index}`);
      }
      expect(release).toHaveBeenCalledTimes(failures.length);
    });
    it('adds what the provider sent to failures only in debug mode, never the credential', async () => {
      const gates = gateStore();
      const config = { ...relayConfig(), debug: true };
      const failures: Array<[() => Response, string, Record<string, unknown>]> = [
        [
          () => completion('Hei</field></field>'),
          'invalid_provider_response',
          { reason: expect.stringContaining('</field>'), answer: expect.stringContaining('Hei</field></field>') },
        ],
        [
          () => completion('Hei', 'length'),
          'provider_truncated',
          { finishReason: 'length', answer: expect.stringContaining('>Hei</field>') },
        ],
        [
          () => new Response('upstream says no', { status: 500 }),
          'provider_failed',
          { status: 500, body: 'upstream says no' },
        ],
      ];
      for (const [index, [upstream, error, debug]] of failures.entries()) {
        const fetcher = vi.fn(async () => upstream());
        vi.stubGlobal('fetch', fetcher);
        const request = await translate(translationRequest({ requestId: `debug-${index}` }));
        const response = await serve(request, relayInput(config, { gateFor: gates.gateFor }));
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({ error, debug });
        expect(text).not.toContain(relaySecrets.MODEL_CREDENTIAL);
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => upstream()),
        );
        const quiet = await serve(
          await translate(translationRequest({ requestId: `quiet-${index}` })),
          relayInput(undefined, { gateFor: gates.gateFor }),
        );
        expect(await quiet.json()).toEqual({ error });
      }
    });
    it('reserves until the request deadline plus cleanup margin and ends an idle provider at its timeout', async () => {
      const gates = gateStore();
      const gate = gates.get(await conformanceScope('app', 'space', 'master'));
      const reserve = vi.spyOn(gate, 'reserve');
      const release = vi.spyOn(gate, 'release');
      const config = relayConfig();
      config.providers.primary.timeoutSeconds = 5;
      config.providers.primary.idleTimeoutSeconds = 1;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
            ),
        ),
      );
      const before = Date.now();
      const response = await serve(
        await translate(translationRequest({ requestId: 'idle' })),
        relayInput(config, { gateFor: gates.gateFor }),
      );
      expect(await errorOf(response)).toEqual({ status: 504, body: { error: 'provider_timeout' } });
      const expiresAt = reserve.mock.calls[0][2];
      // The 5-second provider deadline plus the contract's 10-second cleanup margin.
      expect(expiresAt).toBeGreaterThanOrEqual(before + 15_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15_000);
      expect(release).toHaveBeenCalledWith('idle');
    });
    it('answers result_too_large when the result exceeds the configured result bound', async () => {
      const gates = gateStore();
      const config = relayConfig() as ConformanceConfig & { limits?: unknown };
      config.limits = { resultBytes: 200 };
      vi.stubGlobal('fetch', replying('x'.repeat(300)));
      expect(
        await errorOf(
          await serve(
            await translate(translationRequest({ requestId: 'big' })),
            relayInput(config, { gateFor: gates.gateFor }),
          ),
        ),
      ).toEqual({ status: 502, body: { error: 'result_too_large' } });
    });
    it('lists an admin-selectable alias in health without a model', async () => {
      const input = relayInput(selectableConfig(), { secrets: sharedSecrets });
      expect((await jsonOf(await serve(await signedRequest(), input))).providers).toEqual([
        listed('primary', 'test-model', 'model.example'),
        listed(second, 'another-model', 'another-model.example'),
        {
          alias: selectable,
          host: 'model.example',
          timeoutSeconds: host.timeoutSeconds,
          modelSelection: 'installation',
        },
      ]);
    });
    it('lists provider models for an admin-selectable alias within the deployer policy, without a model call or usage reservation', async () => {
      const fetcher = catalog(['chat-small', 'premium-model', 'chat-pro', 'chat-pro-2', 'premium-model-2', 'mock']);
      vi.stubGlobal('fetch', fetcher);
      const gates = gateStore();
      const input = relayInput(selectableConfig(), { secrets: sharedSecrets, gateFor: gates.gateFor });
      const response = await serve(await listModels(selectable), input);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ models: ['chat-small', 'premium-model-2'] });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(String(fetcher.mock.calls[0][0])).toBe('https://model.example/v1/models');
      expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer server-only-key' });
      expect(gates.gateFor).not.toHaveBeenCalled();
      vi.stubGlobal('fetch', catalog([]));
      expect(await (await serve(await listModels(selectable), input)).json()).toEqual({ models: [] });
    });
    it('refuses model lists outside the caller space, for fixed aliases, and for malformed requests', async () => {
      const fetcher = catalog(['chat-small']);
      vi.stubGlobal('fetch', fetcher);
      const input = relayInput(selectableConfig(), { secrets: sharedSecrets });
      expect(
        await errorOf(await serve(await listModels(selectable, { 'x-contentful-space-id': 'space-two' }), input)),
      ).toEqual({ status: 400, body: { error: 'provider_not_allowed' } });
      expect(await errorOf(await serve(await listModels('missing'), input))).toEqual({
        status: 400,
        body: { error: 'provider_not_allowed' },
      });
      expect(await errorOf(await serve(await listModels('primary'), input))).toEqual({
        status: 400,
        body: { error: 'model_list_unavailable' },
      });
      const rejected = async (requestBody: string, status: number, error: string, headers = {}) =>
        expect(await errorOf(await serve(await signedRequest(headers, requestBody, '/v1/models'), input))).toEqual({
          status,
          body: { error },
        });
      await rejected(JSON.stringify({ provider: selectable }), 415, 'invalid_content_type', {
        'content-type': 'text/plain',
      });
      await rejected(JSON.stringify({ provider: selectable, model: 'x' }), 400, 'unexpected_property');
      await rejected(JSON.stringify({ provider: 1 }), 400, 'invalid_request');
      await rejected(JSON.stringify([]), 400, 'invalid_request');
      await rejected('{bad', 400, 'invalid_json');
      await rejected(JSON.stringify({ provider: selectable, pad: 'x'.repeat(4096) }), 413, 'too_large');
      const signed = await listModels(selectable);
      expect(
        await errorOf(await serve(new Request(signed, { body: JSON.stringify({ provider: 'primary' }) }), input)),
      ).toEqual({ status: 401, body: { error: 'invalid_signature' } });
      expect(fetcher).not.toHaveBeenCalled();
    });
    it('maps missing, malformed, redirected, and failing model list endpoints to model_list_unavailable', async () => {
      const input = relayInput(selectableConfig(), { secrets: sharedSecrets });
      const detail = 'upstream-detail-with-server-only-key';
      for (const upstream of [
        () => new Response(detail, { status: 404 }),
        () => new Response(detail, { status: 500 }),
        () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/models' } }),
        () => new Response(`{"data":"${detail}"}`),
        () => {
          throw new Error(detail);
        },
      ]) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => upstream()),
        );
        const response = await serve(await listModels(selectable), input);
        const text = await response.text();
        expect({ status: response.status, body: JSON.parse(text) }).toEqual({
          status: 502,
          body: { error: 'model_list_unavailable' },
        });
        expect(text).not.toContain('upstream-detail');
      }
    });
    it('translates with an admin-selected model the configuration does not name, within the deployer policy', async () => {
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      const gates = gateStore();
      const input = relayInput(selectableConfig(), { secrets: sharedSecrets, gateFor: gates.gateFor });
      const response = await serve(
        await translate(translationRequest({ requestId: 's1', model: 'newly-released-model' }), selectable),
        input,
      );
      expect(response.status).toBe(200);
      expect(String(fetcher.mock.calls[0][0])).toBe('https://model.example/v1/chat/completions');
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).model).toBe('newly-released-model');
      // The fixed alias at the same endpoint still accepts only its own model.
      expect(
        await errorOf(
          await serve(await translate(translationRequest({ requestId: 's2', model: 'newly-released-model' })), input),
        ),
      ).toEqual({ status: 400, body: { error: 'model_not_allowed' } });
    });
    it('rejects excluded, malformed, and mock models for an admin-selectable alias before the usage gate or provider', async () => {
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      for (const mockTranslation of [false, true]) {
        const gates = gateStore();
        const input = relayInput(
          selectableConfig({ allow: ['chat-*', 'premium-model'], deny: ['premium-model', '*-pro*'] }),
          {
            secrets: sharedSecrets,
            gateFor: gates.gateFor,
            mockTranslation,
          },
        );
        for (const model of ['premium-model', 'chat-pro', 'chat-pro-latest', 'other-model', 'mock', 'bad model'])
          expect({
            model,
            ...(await errorOf(await serve(await translate(translationRequest({ model }), selectable), input))),
          }).toEqual({ model, status: 400, body: { error: 'model_not_allowed' } });
        expect(gates.gateFor).not.toHaveBeenCalled();
        expect(
          (
            await serve(
              await translate(
                translationRequest({ requestId: `ok-${mockTranslation}`, model: 'chat-small' }),
                selectable,
              ),
              input,
            )
          ).status,
        ).toBe(200);
      }
      expect(fetcher).toHaveBeenCalledOnce();
    });
    it('rejects a previously listed model once a deny rule is active', async () => {
      vi.stubGlobal('fetch', catalog(['chat-small', 'chat-large']));
      const before = relayInput(selectableConfig({}), { secrets: sharedSecrets, mockTranslation: true });
      expect(await (await serve(await listModels(selectable), before)).json()).toEqual({
        models: ['chat-large', 'chat-small'],
      });
      expect(
        (await serve(await translate(translationRequest({ model: 'chat-large' }), selectable), before)).status,
      ).toBe(200);
      const after = relayInput(selectableConfig({ deny: ['chat-large'] }), {
        secrets: sharedSecrets,
        mockTranslation: true,
      });
      expect(await (await serve(await listModels(selectable), after)).json()).toEqual({ models: ['chat-small'] });
      expect(
        await errorOf(await serve(await translate(translationRequest({ model: 'chat-large' }), selectable), after)),
      ).toEqual({ status: 400, body: { error: 'model_not_allowed' } });
    });
    it('keeps concurrent requests for two models under one admin-selectable alias distinct', async () => {
      const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        await new Promise(resolve => setTimeout(resolve, model === 'chat-small' ? 10 : 0));
        return completion(`from ${model}`);
      });
      vi.stubGlobal('fetch', fetcher);
      const gates = gateStore();
      const input = relayInput(selectableConfig(), { secrets: sharedSecrets, gateFor: gates.gateFor });
      const [small, large] = await Promise.all([
        serve(
          await translate(translationRequest({ requestId: 'c1', entryId: 'entry-1', model: 'chat-small' }), selectable),
          input,
        ),
        serve(
          await translate(translationRequest({ requestId: 'c2', entryId: 'entry-2', model: 'chat-large' }), selectable),
          input,
        ),
      ]);
      expect(await small.json()).toEqual(translated('c1', 'from chat-small'));
      expect(await large.json()).toEqual(translated('c2', 'from chat-large'));
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('routes two fixed aliases that share an endpoint and credential with their own model and options', async () => {
      const fetcher = replying();
      vi.stubGlobal('fetch', fetcher);
      const config = relayConfig();
      config.providers.precise = { ...config.providers.primary, model: 'other-model', options: { temperature: 0.1 } };
      config.appDefinitions.app.spaces.space = ['primary', 'precise'];
      const gates = gateStore();
      const input = relayInput(config, { gateFor: gates.gateFor });
      expect((await serve(await translate(translationRequest({ requestId: 'f1' })), input)).status).toBe(200);
      expect(
        (await serve(await translate(translationRequest({ requestId: 'f2', model: 'other-model' }), 'precise'), input))
          .status,
      ).toBe(200);
      const sent = fetcher.mock.calls.map(call => ({
        url: String(call[0]),
        authorization: (call[1]?.headers as Record<string, string> | undefined)?.authorization,
        body: JSON.parse(String(call[1]?.body)),
      }));
      expect(sent.map(item => [item.url, item.authorization, item.body.model, item.body.temperature])).toEqual([
        ['https://model.example/v1/chat/completions', 'Bearer server-only-key', 'test-model', undefined],
        ['https://model.example/v1/chat/completions', 'Bearer server-only-key', 'other-model', 0.1],
      ]);
    });
  });
}
