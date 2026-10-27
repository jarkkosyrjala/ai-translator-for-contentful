import {
  backendPath,
  parseTranslateRequest,
  planningLimits,
  RELAY_CONTRACT_VERSION,
  type TranslateRequest,
} from '@ai-translator-for-contentful/protocol';
import { createProvider, listProviderModels, ProviderError } from '@ai-translator-for-contentful/provider';
import {
  loadRelayConfig,
  modelPermitted,
  type RelayConfig,
  type RelayConfigDocument,
  RelayConfigError,
  type RelayProvider,
  type SecretLookup,
} from './config';
import { CLEANUP_MARGIN_MS, CUSTOM_HOST, type RelayHost } from './host';
import { type UsageGate, usageScope, type VerifiedScope } from './usage-gate';

export type RelayHandlerOptions = {
  // RELAY_CONFIG, serialized or as a typed object: App Definitions, their
  // spaces, and provider configurations.
  config: string | RelayConfigDocument | undefined;
  // Reads a secret by a ref that RELAY_CONFIG names.
  secret: SecretLookup;
  // MOCK_TRANSLATION_ENABLED=true, for automated checks only: answers with a
  // deterministic suggestion instead of calling the provider.
  mockTranslation?: boolean;
  // The host's usage gate for one verified scope. Without it, the paid
  // provider route stays disabled.
  gateFor?: (scope: string) => UsageGate;
  // Host settings and bindings that a secret ref must not reuse.
  reservedNames?: readonly string[];
  // The host's deadlines and bounds. Unspecified hosts use CUSTOM_HOST.
  host?: RelayHost;
  // The external path the routes are served beneath, such as
  // `/api/ai-translator`; the Backend URL ends with it. Defaults to the root.
  basePath?: string;
};

// The caller a signature proved: the App Definition whose secret verified it,
// Contentful's signed space, environment and user, and the providers the
// space may use.
export type VerifiedRequest = VerifiedScope & { providers: readonly string[] };

export type RelayHandler = (request: Request) => Promise<Response>;

// A provider in health: a fixed alias names its model; for an admin-selectable
// alias the installation chooses models.
type HealthProvider = { alias: string; host: string; timeoutSeconds: number; maxCompletionTokens?: number } & (
  | { model: string }
  | { modelSelection: 'installation' }
);

const routes = ['/v1/health', '/v1/translate', '/v1/models'];

const requiredSigned = [
  'content-type',
  'x-contentful-timestamp',
  'x-contentful-signed-headers',
  'x-contentful-space-id',
  'x-contentful-environment-id',
  'x-contentful-user-id',
];
// A lowercase HTTP token (RFC 9110 `tchar`), as Contentful normalizes names.
const headerName = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, X-Contentful-Signature, X-Contentful-Signed-Headers, X-Contentful-Timestamp, X-Contentful-Space-Id, X-Contentful-Environment-Id, X-Contentful-User-Id, X-Contentful-CRN',
} as const;

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function readLimited(request: Request, limit: number): Promise<string | null> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function hexToBytes(hex: string): ArrayBuffer | null {
  if (!/^[a-f0-9]{64}$/i.test(hex)) return null;
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  ).buffer;
}

/**
 * Verifies a request signed through Contentful's App Framework request signing.
 * The frontend gets the signature headers from `sdk.cma.appSignedRequest.create`.
 *
 * Follows Contentful's `verifyRequest` reference, with stricter rules: the
 * context headers must be signed and present, the timestamp must be within
 * 60 seconds either way, and the URL has no query string.
 *
 * @param secrets An App Definition's current signing secret, then the previous
 *   one while it rotates.
 * @see https://www.contentful.com/developers/docs/extensibility/app-framework/request-verification/
 * @see https://github.com/contentful/node-apps-toolkit/blob/main/src/requests/verify-request.ts
 * @returns `false` for any missing, stale, or mismatched part; never throws.
 */
export async function verifyContentfulRequest(
  request: Request,
  rawBody: string,
  secrets: readonly string[],
  now = Date.now(),
): Promise<boolean> {
  if (!secrets.some(Boolean)) return false;
  const headers = request.headers;
  // Contentful adds these context headers when signing, so they identify the caller.
  if (
    !headers.get('x-contentful-space-id') ||
    !headers.get('x-contentful-environment-id') ||
    !headers.get('x-contentful-user-id')
  )
    return false;
  // Milliseconds since the epoch. Allowing both directions tolerates clock skew.
  const timestamp = headers.get('x-contentful-timestamp');
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000) return false;
  // Comma-separated, normalized header names. Requiring the context headers
  // stops a signature that leaves them out from passing.
  const signedHeaders = headers.get('x-contentful-signed-headers');
  if (!signedHeaders) return false;
  const names = signedHeaders.split(',');
  if (
    names.length !== new Set(names).size ||
    // Headers.has throws for a name that is not an HTTP token, such as ''.
    names.some(name => !headerName.test(name)) ||
    requiredSigned.some(name => !names.includes(name)) ||
    names.some(name => !headers.has(name))
  )
    return false;
  // HMAC-SHA256 digest as 64 hex characters.
  const supplied = hexToBytes(headers.get('x-contentful-signature') ?? '');
  if (!supplied) return false;
  const url = new URL(request.url);
  if (url.search) return false; // The v1 routes use canonical paths without query strings.
  // Canonical request as in Contentful's signRequest: method, encoded path,
  // `name:value` pairs sorted by name and joined by `;`, and the raw body.
  const signedHeaderValues = [...names]
    .sort()
    .map(name => `${name}:${(headers.get(name) ?? '').trim()}`)
    .join(';');
  const canonical = [request.method, encodeURI(url.pathname), signedHeaderValues, rawBody].join('\n');
  // crypto.subtle.verify compares the digests without a timing leak.
  for (const secret of secrets) {
    if (!secret) continue;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    if (await crypto.subtle.verify('HMAC', key, supplied, new TextEncoder().encode(canonical))) return true;
  }
  return false;
}

// The signed space header only selects candidates: the App Definitions that
// list the space. The one whose secret verifies the request is the caller;
// signing secrets are unique per App Definition, so at most one can.
export async function verifyRelayRequest(
  request: Request,
  rawBody: string,
  config: RelayConfig,
  now = Date.now(),
): Promise<VerifiedRequest | undefined> {
  const spaceId = request.headers.get('x-contentful-space-id') ?? '';
  for (const definition of config.appDefinitions) {
    const providers = definition.spaces.get(spaceId);
    if (!providers || !(await verifyContentfulRequest(request, rawBody, definition.signingSecrets, now))) continue;
    return {
      appDefinitionId: definition.id,
      spaceId,
      environmentId: request.headers.get('x-contentful-environment-id') ?? '',
      providers,
    };
  }
  return undefined;
}

// A model list request names only the provider alias.
function parseModelsRequest(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
  if (Object.keys(value).some(name => name !== 'provider')) throw new Error('unexpected_property');
  if (!('provider' in value) || typeof value.provider !== 'string') throw new Error('invalid_request');
  return value.provider;
}

// Whether the alias accepts this model: its fixed model, or a model within
// the operator's patterns for an admin-selectable alias.
function acceptsModel(provider: RelayProvider, model: string): boolean {
  return provider.models ? modelPermitted(provider.models, model) : model === provider.model;
}

// A Custom backend translation names its provider beside the shared request.
function parseEnvelope(value: unknown): { provider: string; request: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
  if (Object.keys(value).some(name => name !== 'provider' && name !== 'request'))
    throw new Error('unexpected_property');
  if (!('provider' in value) || typeof value.provider !== 'string' || !('request' in value))
    throw new Error('invalid_request');
  return { provider: value.provider, request: value.request };
}

function configurationOf(options: RelayHandlerOptions): RelayConfig | undefined {
  try {
    return loadRelayConfig(options.config, options.secret, options.reservedNames, options.host ?? CUSTOM_HOST);
  } catch (error) {
    // The path names a property, never a secret value.
    console.error(
      JSON.stringify({
        event: 'relay_config_invalid',
        ...(error instanceof RelayConfigError ? { path: error.path, reason: error.reason } : { reason: 'unknown' }),
      }),
    );
    return undefined;
  }
}

// Provider and size failures keep their stable codes; anything else is
// reported as relay_unavailable without detail.
const statuses: Record<string, number> = {
  model_not_allowed: 400,
  provider_rate_limited: 429,
  provider_timeout: 504,
  provider_request_too_large: 413,
  request_too_large: 413,
  provider_auth_failed: 502,
  provider_truncated: 502,
  provider_incomplete: 502,
  provider_refused: 502,
  invalid_provider_response: 502,
  result_too_large: 502,
  provider_failed: 502,
};
// In debug mode a failure also carries what the provider sent, or the
// message of an unexpected error.
function failed(error: unknown, debug: boolean): Response {
  const code = error instanceof Error ? error.message : '';
  const known = Object.hasOwn(statuses, code);
  const details = !debug
    ? undefined
    : error instanceof ProviderError
      ? error.debug
      : known
        ? undefined
        : { reason: error instanceof Error ? error.message : String(error) };
  return json(
    { error: known ? code : 'relay_unavailable', ...(details ? { debug: details } : {}) },
    known ? statuses[code] : 502,
  );
}

// The route beneath the base path, or '' outside it. The prefix ends at a
// segment boundary, so `/api/translator2/v1/health` is not beneath
// `/api/translator`.
function routeOf(pathname: string, prefix: string): string {
  if (!prefix) return pathname;
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : '';
}

/**
 * Serves /v1/health, /v1/translate and /v1/models beneath `basePath` for every
 * App Definition and space that RELAY_CONFIG lists. The host supplies a usage
 * gate per verified scope. Signatures cover the full incoming path; the prefix
 * is removed only to choose the route.
 * @throws RelayConfigError for an ambiguous `basePath`. Configuration problems
 *   are logged instead, and the routes answer `relay_misconfigured`.
 */
export function createRelayHandler(options: RelayHandlerOptions): RelayHandler {
  const prefix = backendPath(options.basePath ?? '');
  if (prefix === undefined) throw new RelayConfigError('basePath', 'invalid_base_path');
  const config = configurationOf(options);
  return async function handle(request: Request): Promise<Response> {
    const path = routeOf(new URL(request.url).pathname, prefix);
    if (request.method === 'OPTIONS')
      return routes.includes(path)
        ? new Response(null, { status: 204, headers: cors })
        : json({ error: 'not_found' }, 404);
    if (!routes.includes(path) || request.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!config) return json({ error: 'relay_misconfigured' }, 503);
    // The deadline counts from arrival, so reading, verification and the
    // reservation spend the same budget as the provider call.
    const started = Date.now();
    const limit = path === '/v1/translate' ? config.limits.requestBytes : 4096;
    let body: string | null;
    try {
      body = await readLimited(request, limit);
    } catch {
      return json({ error: 'invalid_encoding' }, 400);
    }
    if (body === null) return json({ error: 'too_large' }, 413);
    const caller = await verifyRelayRequest(request, body, config);
    if (!caller) return json({ error: 'invalid_signature' }, 401);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (path === '/v1/health') {
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('contract' in parsed) ||
        parsed.contract !== RELAY_CONTRACT_VERSION
      )
        return json({ error: 'unsupported_contract' }, 400);
      return json(
        {
          contract: RELAY_CONTRACT_VERSION,
          status: 'ok',
          modelCall: false,
          providerConfigured: Boolean(options.gateFor),
          providers: caller.providers.flatMap((alias): HealthProvider[] => {
            const provider = config.providers.get(alias);
            if (!provider) return [];
            const allowance = provider.config.options?.maxCompletionTokens;
            const common = {
              alias,
              host: provider.host,
              timeoutSeconds: provider.timeoutSeconds,
              // The configured output allowance, so the planner can warn early.
              ...(allowance !== undefined ? { maxCompletionTokens: allowance } : {}),
            };
            return provider.models
              ? [{ ...common, modelSelection: 'installation' }]
              : [{ ...common, model: provider.model }];
          }),
          // Current backend policy for the app's request planner.
          limits: planningLimits(config.limits),
        },
        200,
      );
    }
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
      return json({ error: 'invalid_content_type' }, 415);
    if (path === '/v1/models') {
      let provider: RelayProvider | undefined;
      try {
        const alias = parseModelsRequest(parsed);
        provider = caller.providers.includes(alias) ? config.providers.get(alias) : undefined;
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'invalid_request' }, 400);
      }
      if (!provider) return json({ error: 'provider_not_allowed' }, 400);
      const policy = provider.models;
      if (!policy) return json({ error: 'model_list_unavailable' }, 400);
      try {
        const models = await listProviderModels({
          endpoint: provider.modelsEndpoint,
          auth: provider.config.auth ?? { mode: 'none' },
          additionalHeaders: provider.config.additionalHeaders,
          timeoutMs: provider.config.timeoutMs,
        });
        return json({ models: models.filter(model => modelPermitted(policy, model)) }, 200);
      } catch {
        return json({ error: 'model_list_unavailable' }, 502);
      }
    }
    let translation: TranslateRequest;
    let provider: RelayProvider | undefined;
    try {
      const envelope = parseEnvelope(parsed);
      provider = caller.providers.includes(envelope.provider) ? config.providers.get(envelope.provider) : undefined;
      if (!provider) return json({ error: 'provider_not_allowed' }, 400);
      translation = parseTranslateRequest(envelope.request, config.limits.requestBytes);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_request';
      if (code === 'request_too_large') return json({ error: code }, 413);
      return json(
        {
          error: ['unsupported_contract', 'invalid_request', 'same_locale', 'unexpected_property'].includes(code)
            ? code
            : 'invalid_request',
        },
        400,
      );
    }
    if (!acceptsModel(provider, translation.model)) return json({ error: 'model_not_allowed' }, 400);
    // The approved model for this request only; the shared alias settings stay unchanged.
    const allowedModels = [translation.model];
    const deadline = started + provider.timeoutSeconds * 1000;
    if (options.mockTranslation) {
      try {
        const mock = createProvider({ mode: 'mock', allowedModels, limits: config.limits });
        return json(await mock.translate(translation, { deadline }), 200);
      } catch (error) {
        return failed(error, config.debug);
      }
    }
    if (!options.gateFor) return json({ error: 'translation_not_enabled' }, 503);
    let reserved = false;
    let gate: UsageGate | undefined;
    try {
      gate = options.gateFor(await usageScope(caller));
      const result = await gate.reserve(translation.entryId, translation.requestId, deadline + CLEANUP_MARGIN_MS);
      if (!result.ok) return json({ error: result.reason }, 429);
      reserved = true;
      return json(
        await createProvider({ ...provider.config, allowedModels, debug: config.debug }).translate(translation, {
          deadline,
        }),
        200,
      );
    } catch (error) {
      return failed(error, config.debug);
    } finally {
      if (reserved && gate) {
        try {
          await gate.release(translation.requestId);
        } catch {
          console.error(JSON.stringify({ event: 'usage_gate_release_failed' }));
        }
      }
    }
  };
}
