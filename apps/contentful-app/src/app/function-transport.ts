import {
  MODEL_LIST_LIMIT,
  type PlanningLimits,
  parseTranslateResponse,
  RELAY_CONTRACT_VERSION,
  type TranslateRequest,
  type TranslateResponse,
  validModelId,
  validPlanningLimits,
} from '@ai-translator-for-contentful/protocol';
import { CHOICE_UNAVAILABLE } from './choices';

type AppActionCallSys =
  | { status: 'succeeded'; result: unknown }
  | { status: 'processing' }
  | { status: 'failed'; error: { message: string } };
type AppActionCallParams = { spaceId: string; environmentId: string; appDefinitionId: string; appActionId: string };

// The part of an app SDK the transport uses. Every app location's SDK satisfies it.
export type FunctionSdk = {
  ids: { app?: string; space: string; environment: string };
  cma: {
    appActionCall: {
      createWithResult(
        params: AppActionCallParams,
        payload: { parameters: Record<string, unknown> },
      ): Promise<{ sys: AppActionCallSys }>;
    };
  };
};

const safeErrors: Record<string, string> = {
  function_not_configured:
    'The Function needs a saved provider URL, API key and model list. Ask a space admin to open app configuration.',
  profile_invalid:
    'The saved instruction profile is invalid. Ask a space admin to reset and save it in app configuration.',
  unsupported_contract:
    'The deployed Function is from another app version. Ask an administrator to upload the matching Function bundle.',
  invalid_provider_url:
    'The saved provider URL is not supported by this Function bundle. Ask a space admin to update it.',
  model_not_allowed: CHOICE_UNAVAILABLE,
  model_list_unavailable:
    'The provider’s model list could not be loaded. Check the provider URL, API key and allowed hosts, or add model IDs manually.',
  provider_auth_failed: 'The provider rejected the saved API key. Ask a space admin to replace it.',
  provider_rate_limited: 'The provider is rate limiting translation. Try again later.',
  provider_timeout: 'The provider did not finish in time.',
  provider_truncated: 'The provider stopped before the answer was complete.',
  provider_incomplete: 'The provider’s answer ended early.',
  provider_refused: 'The provider declined to translate this content.',
  provider_request_too_large: 'The provider rejected the request as too large.',
  request_too_large: 'The request is larger than the Function accepts.',
  result_too_large: 'The answer is larger than the Function can return.',
  invalid_provider_response: 'The provider returned a result the translator could not use.',
  provider_failed: 'The provider request failed. Ask a space admin to check the connection and provider status.',
  invalid_request: 'The translation request is invalid. Reopen the translator and try again.',
};

// A Function failure with its stable code, so retries can tell size
// failures from others.
export class FunctionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function safeFunctionError(error: unknown): FunctionError {
  const message = error instanceof Error ? error.message : '';
  const code = Object.keys(safeErrors).find(candidate => message === candidate || message.endsWith(`: ${candidate}`));
  return new FunctionError(
    code ?? 'function_failed',
    code
      ? safeErrors[code]
      : 'The Contentful Function could not finish. Ask a space admin to check its deployment and configuration.',
  );
}

async function invoke(
  sdk: FunctionSdk,
  action: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (!sdk.ids.app) throw new Error('App definition ID is unavailable');
  let call: Awaited<ReturnType<typeof sdk.cma.appActionCall.createWithResult>>;
  try {
    call = await sdk.cma.appActionCall.createWithResult(
      {
        spaceId: sdk.ids.space,
        environmentId: sdk.ids.environment,
        appDefinitionId: sdk.ids.app,
        appActionId: action,
      },
      { parameters },
    );
  } catch (error) {
    throw safeFunctionError(error);
  }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (call.sys.status === 'failed') throw safeFunctionError(new Error(call.sys.error.message));
  if (call.sys.status !== 'succeeded') throw new Error('The Contentful Function did not finish. Try again.');
  return call.sys.result;
}

export async function functionTranslate(
  sdk: FunctionSdk,
  request: TranslateRequest,
  signal?: AbortSignal,
): Promise<TranslateResponse> {
  if (request.model === 'mock') throw new Error('Mock translation is not available through the Contentful Function.');
  const result = await invoke(sdk, 'translateProvider', request, signal);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Malformed Function result.');
  const response = result as Record<string, unknown>;
  if (
    response.contract === request.contract &&
    response.requestId === request.requestId &&
    typeof response.errorCode === 'string' &&
    Object.keys(response).every(key => ['contract', 'requestId', 'errorCode'].includes(key))
  )
    throw safeFunctionError(new Error(response.errorCode));
  let parsed: TranslateResponse;
  try {
    parsed = parseTranslateResponse(response, request);
  } catch {
    throw new Error('Malformed Function result.');
  }
  if (parsed.provider !== 'openai-compatible') throw new Error('Malformed Function result.');
  return parsed;
}

export type FunctionHealth = {
  contract: typeof RELAY_CONTRACT_VERSION;
  status: 'ok';
  modelCall: false;
  providerConfigured: true;
  providerHost: string;
  models: string[];
  defaultModel?: string;
  profileRevision: string;
  limits: PlanningLimits;
  timeoutSeconds: number;
};

const modelList = (value: unknown, limit: number): value is string[] =>
  Array.isArray(value) && value.length <= limit && value.every(validModelId) && new Set(value).size === value.length;

// The result of a health-style action: its failure becomes a safe error.
async function invokeChecked(sdk: FunctionSdk, action: string, malformed: string): Promise<Record<string, unknown>> {
  const result = await invoke(sdk, action, { contract: RELAY_CONTRACT_VERSION });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(malformed);
  const response = result as Record<string, unknown>;
  if (
    response.contract === RELAY_CONTRACT_VERSION &&
    response.status === 'failed' &&
    response.modelCall === false &&
    typeof response.errorCode === 'string' &&
    Object.keys(response).every(key => ['contract', 'status', 'modelCall', 'errorCode'].includes(key))
  )
    throw safeFunctionError(new Error(response.errorCode));
  return response;
}

// The provider's model IDs, listed by the Function with the saved provider
// settings. Only app configuration calls this; no model is called.
export async function functionModels(sdk: FunctionSdk): Promise<string[]> {
  const result = await invokeChecked(sdk, 'providerModels', 'Malformed Function model list.');
  if (
    Object.keys(result).some(key => !['contract', 'status', 'modelCall', 'models'].includes(key)) ||
    result.contract !== RELAY_CONTRACT_VERSION ||
    result.status !== 'ok' ||
    result.modelCall !== false ||
    !modelList(result.models, 1000)
  )
    throw new Error('Malformed Function model list.');
  return result.models;
}

export async function functionHealth(sdk: FunctionSdk): Promise<FunctionHealth> {
  const health = await invokeChecked(sdk, 'functionHealth', 'Malformed Function connection result.');
  if (
    Object.keys(health).some(
      key =>
        ![
          'contract',
          'status',
          'modelCall',
          'providerConfigured',
          'providerHost',
          'models',
          'defaultModel',
          'profileRevision',
          'limits',
          'timeoutSeconds',
        ].includes(key),
    ) ||
    health.contract !== RELAY_CONTRACT_VERSION ||
    health.status !== 'ok' ||
    health.modelCall !== false ||
    health.providerConfigured !== true ||
    typeof health.profileRevision !== 'string' ||
    !health.profileRevision ||
    health.profileRevision.length > 100 ||
    !validPlanningLimits(health.limits) ||
    typeof health.timeoutSeconds !== 'number' ||
    !Number.isInteger(health.timeoutSeconds) ||
    health.timeoutSeconds < 1 ||
    typeof health.providerHost !== 'string' ||
    health.providerHost.length > 253 ||
    !modelList(health.models, MODEL_LIST_LIMIT) ||
    (health.models.length
      ? typeof health.defaultModel !== 'string' || !health.models.includes(health.defaultModel)
      : health.defaultModel !== undefined)
  ) {
    throw new Error('Malformed Function connection result.');
  }
  return health as FunctionHealth;
}
