import {
  backendPath,
  type PlanningLimits,
  parseTranslateResponse,
  RELAY_CONTRACT_VERSION,
  type TranslateRequest,
  type TranslateResponse,
  validModelId,
  validPlanningLimits,
} from '@ai-translator-for-contentful/protocol';
import type { BaseAppSDK } from '@contentful/app-sdk';
import { CHOICE_UNAVAILABLE, type RelayProviderChoice } from './choices';

type SigningSdk = Pick<BaseAppSDK, 'cma' | 'ids'>;
const BUSY_WAIT_LIMIT_MS = 120_000;

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = `Relay ${status}: ${code}`,
    // What the provider sent, from a relay in debug mode.
    readonly debug?: string,
  ) {
    super(message);
  }
}

// A relay debug object as readable text, keeping a model answer's line breaks.
function debugText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.entries(value)
    .map(([name, item]) => `${name}:${typeof item === 'string' && item.includes('\n') ? '\n' : ' '}${String(item)}`)
    .join('\n');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// The route's URL beneath the Backend URL, which may end with a path such as
// `/api/ai-translator`. Contentful signs this full path.
function routeUrl(backendUrl: string, route: string): URL {
  const base = new URL(backendUrl);
  if (base.protocol !== 'https:') throw new Error('Relay must use HTTPS');
  if (base.username || base.password) throw new Error('Relay URL must not contain credentials');
  const prefix = backendPath(base.pathname);
  if (prefix === undefined || base.search || base.hash) throw new Error('Unexpected relay path');
  const url = new URL(`${prefix}${route}`, base.origin);
  if (url.pathname !== `${prefix}${route}`) throw new Error('Unexpected relay path');
  return url;
}

async function signedPost(
  sdk: SigningSdk,
  backendUrl: string,
  path: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = routeUrl(backendUrl, path);
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (!sdk.ids.app) throw new Error('App definition ID unavailable');
  const signed = await sdk.cma.appSignedRequest.create(
    { spaceId: sdk.ids.space, environmentId: sdk.ids.environment, appDefinitionId: sdk.ids.app },
    { method: 'POST', path: url.pathname, headers, body },
  );
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, ...signed.additionalHeaders },
    body,
    signal,
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    // A host in front of the backend answered without the contract's JSON,
    // for example a gateway timeout or a body size limit.
    throw new RelayError(
      response.status,
      response.status === 413 ? 'request_too_large' : response.status === 504 ? 'provider_timeout' : 'request_failed',
    );
  }
  if (!response.ok) {
    const code = result && typeof result === 'object' && 'error' in result ? String(result.error) : 'request_failed';
    const debug = result && typeof result === 'object' && 'debug' in result ? debugText(result.debug) : undefined;
    throw new RelayError(response.status, code, undefined, debug);
  }
  return result;
}

export type { RelayProviderChoice };

export type HealthResult = {
  contract: typeof RELAY_CONTRACT_VERSION;
  status: 'ok';
  modelCall: false;
  providerConfigured: boolean;
  providers: RelayProviderChoice[];
  // The backend's current request and result bounds for the planner.
  limits: PlanningLimits;
};

const nonEmpty = (value: unknown) => typeof value === 'string' && value.length > 0;

const positive = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0;

function healthProvider(choice: unknown): boolean {
  if (!choice || typeof choice !== 'object' || !('alias' in choice) || !nonEmpty(choice.alias)) return false;
  if (!('host' in choice) || !nonEmpty(choice.host)) return false;
  if (!('timeoutSeconds' in choice) || !positive(choice.timeoutSeconds)) return false;
  if ('maxCompletionTokens' in choice && !positive(choice.maxCompletionTokens)) return false;
  return 'modelSelection' in choice
    ? choice.modelSelection === 'installation' && !('model' in choice)
    : 'model' in choice && nonEmpty(choice.model);
}

export async function signedHealth(sdk: SigningSdk, backendUrl: string): Promise<HealthResult> {
  const result = await signedPost(sdk, backendUrl, '/v1/health', { contract: RELAY_CONTRACT_VERSION });
  if (
    !result ||
    typeof result !== 'object' ||
    !('contract' in result) ||
    result.contract !== RELAY_CONTRACT_VERSION ||
    !('status' in result) ||
    result.status !== 'ok' ||
    !('modelCall' in result) ||
    result.modelCall !== false ||
    !('providerConfigured' in result) ||
    typeof result.providerConfigured !== 'boolean' ||
    !('limits' in result) ||
    !validPlanningLimits(result.limits) ||
    !('providers' in result) ||
    !Array.isArray(result.providers) ||
    !result.providers.every(healthProvider)
  )
    throw new Error('Incompatible relay health response');
  return result as HealthResult;
}

// The model IDs an admin-selectable alias's provider lists, within the
// operator's patterns. Only app configuration calls this; no model is called.
export async function signedModels(sdk: SigningSdk, backendUrl: string, provider: string): Promise<string[]> {
  const result = await signedPost(sdk, backendUrl, '/v1/models', { provider });
  if (
    !result ||
    typeof result !== 'object' ||
    Object.keys(result).some(key => key !== 'models') ||
    !('models' in result) ||
    !Array.isArray(result.models) ||
    !result.models.every(validModelId)
  )
    throw new Error('Incompatible model list response');
  return result.models;
}

// The Custom backend translation body: the chosen provider alias beside the
// shared request. Request planning measures this same object.
export function relayEnvelope(provider: string, request: TranslateRequest) {
  return { provider, request };
}

export async function signedTranslate(
  sdk: SigningSdk,
  backendUrl: string,
  provider: string,
  payload: TranslateRequest,
  signal?: AbortSignal,
): Promise<TranslateResponse> {
  let result: unknown;
  // A same-entry request is rejected before its ID is reserved, so retry the
  // same request after the active translation has had time to finish.
  for (let delay = 1000, waited = 0; ; delay = Math.min(delay * 2, 8000)) {
    try {
      result = await signedPost(sdk, backendUrl, '/v1/translate', relayEnvelope(provider, payload), signal);
      break;
    } catch (error) {
      // A choice the backend no longer allows is not retried with another one.
      if (error instanceof RelayError && (error.code === 'provider_not_allowed' || error.code === 'model_not_allowed'))
        throw new RelayError(error.status, error.code, CHOICE_UNAVAILABLE, error.debug);
      if (!(error instanceof RelayError) || error.code !== 'concurrency_limit' || waited >= BUSY_WAIT_LIMIT_MS)
        throw error;
      const pause = Math.min(delay, BUSY_WAIT_LIMIT_MS - waited);
      await wait(pause, signal);
      waited += pause;
    }
  }
  try {
    return parseTranslateResponse(result, payload);
  } catch {
    throw new Error('Invalid relay translation response');
  }
}
