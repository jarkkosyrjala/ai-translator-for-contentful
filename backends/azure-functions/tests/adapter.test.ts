import { createAzureRelayHandler } from '@ai-translator-for-contentful/backend/azure';
import {
  type ConformanceInput,
  CUSTOM_HOST_EXPECTATION,
  createMemoryUsageGate,
  describeRelayConformance,
  relayConfig,
  relayInput,
  signRequest,
} from '@ai-translator-for-contentful/relay-conformance';
import { HttpRequest } from '@azure/functions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRelaySettings } from '../src/settings';

// Converts a Web request into the Functions HTTP request the host would pass,
// with the host's public URL.
async function azureRequest(request: Request): Promise<HttpRequest> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const url = new URL(request.url);
  return new HttpRequest({
    method: request.method,
    url: `https://translator.azure.example${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    ...(bytes.byteLength ? { body: { bytes } } : {}),
  });
}

function serve(handler: ReturnType<typeof createAzureRelayHandler>) {
  return async (request: Request): Promise<Response> => {
    const init = await handler(await azureRequest(request));
    return new Response(typeof init.body === 'string' ? init.body : null, {
      status: init.status,
      headers: init.headers,
    });
  };
}

// Every secret is an app setting named by its ref beside RELAY_CONFIG.
function relayHandler({ config, secrets, mockTranslation, gateFor }: ConformanceInput) {
  return createAzureRelayHandler({
    ...readRelaySettings({
      ...secrets,
      RELAY_CONFIG: config,
      ...(mockTranslation ? { MOCK_TRANSLATION_ENABLED: 'true' } : {}),
    }),
    gateFor,
  });
}

describeRelayConformance('standalone Azure Functions settings with in-memory gate', {
  createGates: () => () => createMemoryUsageGate(),
  createHandler: input => serve(relayHandler(input)),
  host: { ...CUSTOM_HOST_EXPECTATION, timeoutSeconds: 220 },
});

describe('standalone Azure Functions settings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps secret refs out of settings the Function App and Azure use', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const ref of ['USAGE_GATE_TABLE', 'FUNCTIONS_WORKER_RUNTIME', 'WEBSITE_RUN_FROM_PACKAGE', 'AZURE_CLIENT_ID']) {
      const config = relayConfig();
      config.appDefinitions.app.signingSecretRef = ref;
      const response = await serve(relayHandler(relayInput(config)))(await signRequest());
      expect(response.status).toBe(503);
      expect(error).toHaveBeenLastCalledWith(
        JSON.stringify({
          event: 'relay_config_invalid',
          path: 'appDefinitions["app"].signingSecretRef',
          reason: 'reserved_ref',
        }),
      );
    }
    expect((await serve(relayHandler(relayInput()))(await signRequest())).status).toBe(200);
  });
});
