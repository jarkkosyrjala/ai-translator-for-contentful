import {
  type ModelChoice,
  parseModelChoices,
  parseModelList,
  parseModelSelection,
  parseProviderAuth,
  parseProviderHeaders,
  parseProviderOptions,
  providerBaseUrl,
} from '@ai-translator-for-contentful/protocol';
import type { Params } from './transport-config';

export type FunctionAdvancedParams = {
  functionAuthMode?: 'bearer' | 'header' | 'none';
  functionAuthHeader?: string;
  functionTemperature?: number;
  functionTopP?: number;
  functionMaxCompletionTokens?: number;
  functionOutputTokenField?: 'max_completion_tokens' | 'max_tokens';
  functionReasoningEffort?: string;
  functionExtraBody?: string;
  functionExtraHeaders?: string;
  functionHeadersPresent?: boolean;
  functionTimeoutSeconds?: number;
  functionIdleTimeoutSeconds?: number;
};

// Contentful allows a Function 30 seconds; the provider deadline stays 3
// seconds below it.
export const FUNCTION_MAX_TIMEOUT_SECONDS = 27;

export const FUNCTION_PROVIDER_EXAMPLE = 'https://provider.example.com/v1';

// The provider connection alone: URL, authentication, Secrets, and options.
// It can be saved before any model is chosen, so models can be discovered.
export function functionConnectionError(params: Params & FunctionAdvancedParams): string | undefined {
  if (!params.functionProviderUrl?.trim()) return 'Enter a supported provider URL.';
  try {
    providerBaseUrl(params.functionProviderUrl);
  } catch {
    return 'Enter a public HTTPS provider base URL without credentials, query, or fragment.';
  }
  if (params.functionAuthMode !== 'none' && !params.functionKeyPresent)
    return 'Add a provider credential and save it as a Contentful Secret.';
  try {
    parseProviderAuth(params.functionAuthMode, 'validation-only', params.functionAuthHeader);
  } catch {
    return 'Choose a valid authentication mode and header name.';
  }
  try {
    parseProviderOptions({
      temperature: params.functionTemperature,
      topP: params.functionTopP,
      maxCompletionTokens: params.functionMaxCompletionTokens,
      outputTokenField: params.functionOutputTokenField,
      reasoningEffort: params.functionReasoningEffort,
      extraBody: params.functionExtraBody,
    });
  } catch {
    return 'Check the advanced provider request options.';
  }
  const timeout = params.functionTimeoutSeconds ?? FUNCTION_MAX_TIMEOUT_SECONDS;
  const idle = params.functionIdleTimeoutSeconds ?? timeout;
  const valid = (value: number) => Number.isInteger(value) && value >= 1 && value <= FUNCTION_MAX_TIMEOUT_SECONDS;
  if (!valid(timeout) || !valid(idle) || idle > timeout)
    return `Use whole seconds from 1 to ${FUNCTION_MAX_TIMEOUT_SECONDS} for the timeouts, with the idle timeout at most the timeout.`;
}

// The saved model list and default agree: an empty list without a default,
// or a default from a nonempty list.
export function functionModelsError(
  params: Pick<Params, 'functionModels' | 'functionDefaultModel'>,
): string | undefined {
  try {
    parseModelList(params.functionModels);
  } catch {
    return 'The saved model list could not be read. Choose the models again.';
  }
  try {
    parseModelSelection(params.functionModels, params.functionDefaultModel);
  } catch {
    return 'Choose a default model from the enabled models.';
  }
  return undefined;
}

// The enabled models, even while the default needs repair.
export function functionModelList(params: Pick<Params, 'functionModels'>): string[] {
  try {
    return parseModelList(params.functionModels);
  } catch {
    return [];
  }
}

// The enabled models with their planner settings.
export function functionModelChoices(params: Pick<Params, 'functionModels'>): ModelChoice[] {
  try {
    return parseModelChoices(params.functionModels);
  } catch {
    return [];
  }
}

export function functionModelSelection(params: Pick<Params, 'functionModels' | 'functionDefaultModel'>): {
  models: string[];
  defaultModel?: string;
  choices: ModelChoice[];
} {
  try {
    return parseModelSelection(params.functionModels, params.functionDefaultModel);
  } catch {
    return { models: [], choices: [] };
  }
}

// Why editors cannot translate through the Function yet.
export function functionReadinessError(params: Params & FunctionAdvancedParams): string | undefined {
  const error = functionConnectionError(params) ?? functionModelsError(params);
  if (error) return error;
  if (!functionModelSelection(params).models.length) return 'Choose the models editors may use and a default model.';
  return undefined;
}

export function functionProviderHost(params: Pick<Params, 'functionProviderUrl'>): string | undefined {
  return params.functionProviderUrl ? new URL(params.functionProviderUrl).hostname : undefined;
}

// Whether Function health describes these saved settings: the same provider
// host, models in the same order, and default. Stale settings need a reopen.
export function functionHealthMatches(
  health: { providerHost: string; models: string[]; defaultModel?: string },
  params: Params,
): boolean {
  const saved = functionModelSelection(params);
  return (
    health.providerHost === functionProviderHost(params) &&
    JSON.stringify(health.models) === JSON.stringify(saved.models) &&
    health.defaultModel === saved.defaultModel
  );
}

export type SecretEdit = { mode: 'keep' } | { mode: 'replace'; value: string } | { mode: 'clear' };
export type KeyEdit = SecretEdit;

export function configuredKeyPresent(saved: unknown, edit: KeyEdit): boolean {
  return edit.mode === 'replace' ? Boolean(edit.value.trim()) : edit.mode === 'clear' ? false : Boolean(saved);
}

export function configuredParameters(
  params: Params & FunctionAdvancedParams,
  savedSecret: unknown,
  keyEdit: KeyEdit,
  savedHeaders?: unknown,
  headerEdit: SecretEdit = { mode: 'keep' },
): (Params & FunctionAdvancedParams) | undefined {
  const values = { ...params };
  delete values.functionApiKey;
  delete values.functionExtraHeaders;
  values.functionKeyPresent = configuredKeyPresent(params.functionKeyPresent, keyEdit);
  if (keyEdit.mode === 'replace') {
    if (!keyEdit.value.trim() || keyEdit.value !== keyEdit.value.trim() || keyEdit.value.length > 4096)
      return undefined;
    values.functionApiKey = keyEdit.value;
  } else if (keyEdit.mode === 'keep' && values.functionKeyPresent) {
    // Pass the SDK's redacted value back verbatim. Never fabricate a marker.
    // If Contentful provides no value, refuse Save rather than erase the Secret.
    if (typeof savedSecret !== 'string' || !savedSecret) return undefined;
    values.functionApiKey = savedSecret;
  } else {
    values.functionApiKey = '';
  }
  values.functionHeadersPresent =
    headerEdit.mode === 'replace' ? true : headerEdit.mode === 'clear' ? false : Boolean(params.functionHeadersPresent);
  if (headerEdit.mode === 'replace') {
    try {
      if (!Object.keys(parseProviderHeaders(headerEdit.value)).length) return undefined;
    } catch {
      return undefined;
    }
    values.functionExtraHeaders = headerEdit.value;
  } else if (headerEdit.mode === 'keep' && values.functionHeadersPresent) {
    if (typeof savedHeaders !== 'string' || !savedHeaders) return undefined;
    values.functionExtraHeaders = savedHeaders;
  } else {
    values.functionExtraHeaders = '';
  }
  return values;
}
