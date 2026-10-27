import type { HttpFunctionOptions, SetupOptions, TimerFunctionOptions } from '@azure/functions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registered = vi.hoisted(() => ({
  setup: [] as SetupOptions[],
  http: new Map<string, HttpFunctionOptions>(),
  timer: new Map<string, TimerFunctionOptions>(),
}));

vi.mock('@azure/functions', async importOriginal => ({
  ...(await importOriginal<typeof import('@azure/functions')>()),
  app: {
    setup: (options: SetupOptions) => registered.setup.push(options),
    http: (name: string, options: HttpFunctionOptions) => registered.http.set(name, options),
    timer: (name: string, options: TimerFunctionOptions) => registered.timer.set(name, options),
  },
}));

const settings = {
  RELAY_CONFIG: JSON.stringify({
    appDefinitions: { app: { signingSecretRef: 'APP_SIGNING', spaces: { space: ['primary'] } } },
    providers: { primary: { baseUrl: 'https://model.example/v1', model: 'test-model', credentialRef: 'MODEL_KEY' } },
  }),
  APP_SIGNING: 'a'.repeat(64),
  MODEL_KEY: 'server-only-key',
};

async function load(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  registered.setup.length = 0;
  registered.http.clear();
  registered.timer.clear();
  await import('../src/index');
}

describe('Function App registration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('streams HTTP bodies and serves every relay route anonymously from one function', async () => {
    await load(settings);
    expect(registered.setup).toEqual([{ enableHttpStream: true }]);
    expect([...registered.http.keys()]).toEqual(['relay']);
    expect(registered.http.get('relay')).toMatchObject({
      route: '{*path}',
      authLevel: 'anonymous',
      methods: expect.arrayContaining(['POST', 'OPTIONS', 'GET']),
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('prunes the usage gate daily only when it has storage', async () => {
    await load(settings);
    expect(registered.timer.size).toBe(0);
    await load({ ...settings, USAGE_GATE_TABLE_ENDPOINT: 'https://account.table.core.windows.net' });
    expect(registered.timer.get('pruneUsageGate')).toMatchObject({ schedule: '0 17 3 * * *' });
  });

  it('logs storage problems and the invalid configuration path without values', async () => {
    await load({
      ...settings,
      APP_SIGNING: '',
      USAGE_GATE_TABLE_ENDPOINT: 'http://account.table.core.windows.net',
    });
    expect(vi.mocked(console.error).mock.calls).toEqual([
      [JSON.stringify({ event: 'usage_gate_misconfigured', reason: 'invalid_endpoint' })],
      [
        JSON.stringify({
          event: 'relay_config_invalid',
          path: 'appDefinitions["app"].signingSecretRef',
          reason: 'unresolved_ref',
        }),
      ],
    ]);
  });
});
