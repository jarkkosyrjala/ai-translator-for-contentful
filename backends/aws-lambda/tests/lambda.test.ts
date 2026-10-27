import {
  CUSTOM_HOST_EXPECTATION,
  completion,
  conformanceScope,
  describeRelayConformance,
  envelope,
  relayConfig,
  relaySecrets,
  signRequest,
} from '@ai-translator-for-contentful/relay-conformance';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvironmentHandler, createFunctionUrlHandler } from '../src/handler';
import { toRequest, toResult } from '../src/http';
import { parseSecretValues, SecretFormatError } from '../src/settings';
import { createUsageGate } from '../src/usage-gate';
import { createMemoryGateStore, toEvent, toResponse } from './function-url';

// RELAY_CONFIG and the mock flag are environment variables; every secret is a
// key of the Secrets Manager JSON secret.
describeRelayConformance('AWS Lambda function URL', {
  createGates: () => () => createUsageGate(createMemoryGateStore()),
  createHandler: ({ config, secrets, mockTranslation, gateFor }) => {
    const handler = createFunctionUrlHandler({
      environment: {
        RELAY_CONFIG: config,
        FUNCTION_TIMEOUT_SECONDS: '610',
        ...(mockTranslation ? { MOCK_TRANSLATION_ENABLED: 'true' } : {}),
      },
      loadSecret: async () => JSON.stringify(secrets),
      gateFor,
    });
    return async request => toResponse(await handler(await toEvent(request)));
  },
  host: {
    ...CUSTOM_HOST_EXPECTATION,
    limits: { ...CUSTOM_HOST_EXPECTATION.limits, resultBytes: 2 * 1_048_576 },
  },
});

describe('AWS Lambda relay secret', () => {
  it('accepts only a JSON object of secret refs to strings', () => {
    expect(parseSecretValues(undefined)).toEqual({});
    expect(parseSecretValues('{"APP_SIGNING":"a","MODEL_CREDENTIAL":"b"}')).toEqual({
      APP_SIGNING: 'a',
      MODEL_CREDENTIAL: 'b',
    });
    const code = (text: string) => {
      try {
        parseSecretValues(text);
      } catch (error) {
        return error instanceof SecretFormatError ? error.code : 'other';
      }
      return 'parsed';
    };
    expect(code('not json')).toBe('not_json');
    expect(code('["APP_SIGNING"]')).toBe('not_object');
    for (const key of [
      'app_signing',
      'RELAY_CONFIG',
      'MOCK_TRANSLATION_ENABLED',
      'RELAY_SECRET_ID',
      'USAGE_TABLE_NAME',
      'FUNCTION_TIMEOUT_SECONDS',
    ])
      expect(code(JSON.stringify({ [key]: 'value' }))).toBe('unexpected_key');
    expect(code('{"APP_SIGNING":1}')).toBe('not_string');
  });

  it('selects the DynamoDB gate item by the verified scope', async () => {
    const keys: string[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetItemCommand) keys.push(String(command.input.Key?.pk?.S));
      return {};
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => completion('Hei')),
    );
    try {
      const { handler } = createEnvironmentHandler(
        {
          RELAY_CONFIG: JSON.stringify(relayConfig()),
          RELAY_SECRET_ID: 'example-secret',
          USAGE_TABLE_NAME: 'gate',
          FUNCTION_TIMEOUT_SECONDS: '610',
        },
        {
          dynamodb: { send } as never,
          getSecret: async secretId => (secretId === 'example-secret' ? JSON.stringify(relaySecrets) : undefined),
        },
      );
      for (const environment of ['master', 'staging'])
        expect(
          toResponse(
            await handler(
              await toEvent(
                await signRequest({ 'x-contentful-environment-id': environment }, envelope(), '/v1/translate'),
              ),
            ),
          ).status,
        ).toBe(200);
      const scopes = [
        await conformanceScope('app', 'space', 'master'),
        await conformanceScope('app', 'space', 'staging'),
      ];
      expect(keys.filter(key => key.startsWith('installation#'))).toEqual(scopes.map(scope => `installation#${scope}`));
      expect(keys.filter(key => key.startsWith('request#'))).toEqual(scopes.map(scope => `request#${scope}#rule-1`));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('AWS Lambda function URL adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers relay_misconfigured without logging the secret when it cannot be used', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const environment = { RELAY_CONFIG: JSON.stringify(relayConfig()), FUNCTION_TIMEOUT_SECONDS: '610' };
    for (const [loadSecret, reason] of [
      [async () => '{"APP_SIGNING":', 'not_json'],
      [async () => JSON.stringify({ ...relaySecrets, RELAY_CONFIG: '{}' }), 'unexpected_key'],
      [() => Promise.reject(new Error('AccessDeniedException')), 'read_failed'],
    ] as const) {
      const handler = createFunctionUrlHandler({ environment, loadSecret });
      const response = toResponse(await handler(await toEvent(await signRequest())));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'relay_misconfigured' });
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'relay_secret_unavailable', reason }));
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(relaySecrets.APP_SIGNING);
  });

  it('requires the function timeout and keeps provider deadlines 10 seconds below it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadSecret = async () => JSON.stringify(relaySecrets);
    const status = async (environment: Record<string, string>) =>
      toResponse(await createFunctionUrlHandler({ environment, loadSecret })(await toEvent(await signRequest())))
        .status;
    const config = relayConfig();
    expect(await status({ RELAY_CONFIG: JSON.stringify(config) })).toBe(503);
    expect(await status({ RELAY_CONFIG: JSON.stringify(config), FUNCTION_TIMEOUT_SECONDS: '901' })).toBe(503);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('FUNCTION_TIMEOUT_SECONDS'));
    config.providers.primary.timeoutSeconds = 890;
    expect(await status({ RELAY_CONFIG: JSON.stringify(config), FUNCTION_TIMEOUT_SECONDS: '900' })).toBe(200);
    expect(await status({ RELAY_CONFIG: JSON.stringify(config), FUNCTION_TIMEOUT_SECONDS: '610' })).toBe(503);
  });

  it('keeps maximum request and result bodies within the 6 MiB function URL payloads', async () => {
    const MiB = 1_048_576;
    // The worst case for the result: every byte of the relay JSON needs a
    // second escape in the function URL result.
    const body = JSON.stringify({ text: '"'.repeat(2 * MiB - 20) });
    expect(body.length).toBeGreaterThan(4 * MiB - 64);
    const result = await toResult(
      new Response(body.slice(0, 2 * MiB), { headers: { 'content-type': 'application/json' } }),
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6 * MiB);
    const event = await toEvent(
      new Request('https://abc.lambda-url.eu-north-1.on.aws/v1/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(2 * MiB),
      }),
    );
    const encoded = { ...event, body: Buffer.from(event.body ?? '').toString('base64'), isBase64Encoded: true };
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(6 * MiB);
  });

  it('rebuilds the request URL, headers, and base64 body from the event', async () => {
    const event = await toEvent(
      new Request('https://abc.lambda-url.eu-north-1.on.aws/v1/health?check=1', {
        method: 'POST',
        headers: { origin: 'https://relay.example', 'content-type': 'application/json' },
        body: '{"contract":1}',
      }),
    );
    const request = toRequest({
      ...event,
      body: Buffer.from('{"contract":1}').toString('base64'),
      isBase64Encoded: true,
    });
    expect(request.url).toBe('https://abc.lambda-url.eu-north-1.on.aws/v1/health?check=1');
    expect(request.headers.get('origin')).toBe('https://relay.example');
    expect(await request.text()).toBe('{"contract":1}');
    const preflight = toRequest({
      ...event,
      requestContext: { ...event.requestContext, http: { ...event.requestContext.http, method: 'OPTIONS' } },
      body: undefined,
      headers: { origin: 'https://relay.example' },
    });
    expect(preflight.method).toBe('OPTIONS');
    expect(preflight.headers.has('content-type')).toBe(false);
  });

  it('returns the relay response as a function URL result', async () => {
    expect(
      await toResult(
        new Response('{"error":"not_found"}', {
          status: 404,
          headers: { 'Content-Type': 'application/json', Vary: 'Origin' },
        }),
      ),
    ).toEqual({
      statusCode: 404,
      headers: { 'content-type': 'application/json', vary: 'Origin' },
      body: '{"error":"not_found"}',
      isBase64Encoded: false,
    });
    expect(await toResult(new Response(null, { status: 204 }))).toEqual({
      statusCode: 204,
      headers: {},
      body: '',
      isBase64Encoded: false,
    });
  });
});
