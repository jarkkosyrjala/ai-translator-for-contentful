import { defaultInstructionProfile } from '@ai-translator-for-contentful/protocol';

// Synthetic identities, secrets and payloads only. Never put real space IDs,
// users, credentials or content in conformance fixtures.
export type ReservationResult = { ok: true } | { ok: false; reason: 'duplicate_request' | 'concurrency_limit' };

export interface ConformanceGate {
  reserve(entryId: string, requestId: string, expiresAt: number): ReservationResult | Promise<ReservationResult>;
  release(requestId: string): void | Promise<void>;
}

// A RELAY_CONFIG document. Tests change copies of it to cover invalid settings.
export type ConformanceConfig = {
  appDefinitions: Record<
    string,
    { signingSecretRef: string; previousSigningSecretRef?: string; spaces: Record<string, string[]> }
  >;
  providers: Record<string, Record<string, unknown>>;
};

// What a host's entry point is configured with: RELAY_CONFIG, every secret by
// its ref (each host stores them in its own form), MOCK_TRANSLATION_ENABLED,
// and the usage gate of a verified scope.
export type ConformanceInput = {
  config: string;
  secrets: Readonly<Record<string, string>>;
  mockTranslation: boolean;
  gateFor?: (scope: string) => ConformanceGate;
};

export const relaySecrets: Readonly<Record<string, string>> = {
  APP_SIGNING: 'a'.repeat(64),
  MODEL_CREDENTIAL: 'server-only-key',
};

export function relayConfig(): ConformanceConfig {
  return {
    appDefinitions: { app: { signingSecretRef: 'APP_SIGNING', spaces: { space: ['primary'] } } },
    providers: {
      primary: {
        baseUrl: 'https://model.example/v1',
        model: 'test-model',
        authMode: 'bearer',
        credentialRef: 'MODEL_CREDENTIAL',
      },
    },
  };
}

export function relayInput(
  config: ConformanceConfig | string = relayConfig(),
  change: Partial<ConformanceInput> = {},
): ConformanceInput {
  return {
    config: typeof config === 'string' ? config : JSON.stringify(config),
    secrets: relaySecrets,
    mockTranslation: false,
    ...change,
  };
}

export const healthBody = JSON.stringify({ contract: 1 });

const profile = defaultInstructionProfile();

// A contract 1 request with one text work field.
export function translationRequest(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: 1,
    requestId: 'rule-1',
    entryId: 'entry-a',
    model: 'test-model',
    sourceLocale: 'en-US',
    targetLocale: 'fi-FI',
    availableLocales: ['en-US', 'fi-FI'],
    profile,
    profileRevision: profile.revision,
    fields: [{ id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source: 'Hello' }],
    ...fields,
  };
}

// The model answer for the request above, as a provider streams it.
export function completion(text = 'Hei', finish = 'stop'): Response {
  const content = `<translation><field id="f-title" type="text">${text}</field></translation>`;
  const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  return new Response(
    `${event({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

// The relay's answer for a completed request.
export function translated(requestId: string, text: string, provider = 'openai-compatible') {
  return {
    contract: 1,
    requestId,
    provider,
    profileRevision: profile.revision,
    results: [{ id: 'f-title', status: 'ok', type: 'text', text }],
  };
}

// The Custom backend translation body: the chosen provider alias beside the
// shared translation request.
export function envelope(request: Record<string, unknown> = translationRequest(), provider = 'primary'): string {
  return JSON.stringify({ provider, request });
}

// The scope the relay derives from a verified App Definition, space and
// environment: the SHA-256 hex digest of their JSON array.
export async function conformanceScope(appDefinitionId: string, spaceId: string, environmentId: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([appDefinitionId, spaceId, environmentId])),
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Signs a request the way Contentful's app signing request does: HMAC-SHA256
// over method, path, sorted signed headers and the exact body. Header
// overrides are signed too, as Contentful signs its own context headers.
export async function signRequest(
  overrides: Record<string, string> = {},
  requestBody = healthBody,
  path = '/v1/health',
  secret = relaySecrets.APP_SIGNING,
): Promise<Request> {
  const timestamp = String(Date.now());
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-contentful-space-id': 'space',
    'x-contentful-environment-id': 'master',
    'x-contentful-user-id': 'user',
    'x-contentful-timestamp': timestamp,
  };
  headers['x-contentful-signed-headers'] = Object.keys(headers).concat('x-contentful-signed-headers').sort().join(',');
  Object.assign(headers, overrides);
  const names = headers['x-contentful-signed-headers'].split(',').sort();
  const canonical = ['POST', path, names.map(name => `${name}:${headers[name]}`).join(';'), requestBody].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  headers['x-contentful-signature'] = Array.from(new Uint8Array(sig), byte => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  headers.origin = 'https://relay.example';
  return new Request(`https://relay.example${path}`, { method: 'POST', headers, body: requestBody });
}
