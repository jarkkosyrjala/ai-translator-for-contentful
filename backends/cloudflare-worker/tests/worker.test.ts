import {
  type ConformanceInput,
  completion,
  conformanceScope,
  describeRelayConformance,
  envelope,
  relayConfig,
  relayInput,
  signRequest,
  translationRequest,
} from '@ai-translator-for-contentful/relay-conformance';
import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/worker';
import { durableObjectGate } from './durable-object';

// Secrets become Worker secret bindings beside the RELAY_CONFIG text binding.
function bindings({ config, secrets, mockTranslation, gateFor }: ConformanceInput): Env {
  return {
    ...secrets,
    RELAY_CONFIG: config,
    ...(mockTranslation ? { MOCK_TRANSLATION_ENABLED: 'true' } : {}),
    ...(gateFor ? { USAGE_GATE: { getByName: gateFor } } : {}),
  } as unknown as Env;
}

describeRelayConformance('Cloudflare Worker with Durable Object gate', {
  createGates: () => () => durableObjectGate(),
  createHandler: input => request => worker.fetch(request, bindings(input)),
});

describe('Cloudflare usage gate binding', () => {
  it('names one Durable Object per verified App Definition, space, and environment', async () => {
    const gate = durableObjectGate();
    const getByName = vi.fn(() => gate);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => completion('Hei')),
    );
    try {
      const env = { ...bindings(relayInput()), USAGE_GATE: { getByName } } as unknown as Env;
      for (const environment of ['master', 'staging'])
        expect(
          (
            await worker.fetch(
              await signRequest(
                { 'x-contentful-environment-id': environment },
                envelope(translationRequest({ requestId: environment })),
                '/v1/translate',
              ),
              env,
            )
          ).status,
        ).toBe(200);
      expect(getByName.mock.calls).toEqual([
        [await conformanceScope('app', 'space', 'master')],
        [await conformanceScope('app', 'space', 'staging')],
      ]);
    } finally {
      vi.unstubAllGlobals();
      gate.close();
    }
  });
  it('rejects a secret ref that reuses the USAGE_GATE binding', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const config = relayConfig();
      config.appDefinitions.app.signingSecretRef = 'USAGE_GATE';
      const response = await worker.fetch(await signRequest(), bindings(relayInput(config)));
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 503,
        body: { error: 'relay_misconfigured' },
      });
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'relay_config_invalid',
          path: 'appDefinitions["app"].signingSecretRef',
          reason: 'reserved_ref',
        }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
