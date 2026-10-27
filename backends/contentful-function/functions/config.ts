import {
  effectiveInstructionProfile,
  type InstructionProfile,
  type ModelChoice,
  type ProviderAuth,
  type ProviderRequestOptions,
  parseModelSelection,
  parseProviderAuth,
  parseProviderHeaders,
  parseProviderOptions,
  providerBaseUrl,
  providerEndpoint,
  providerModelsEndpoint,
  TRANSLATION_ERROR_CODES,
} from '@ai-translator-for-contentful/protocol';
import { providerHeaders } from '@ai-translator-for-contentful/provider';
import type { FunctionEventContext } from '@contentful/node-apps-toolkit';

// The installation's provider connection, without its model choices.
export type FunctionProviderConfig = {
  endpoint: string;
  modelsEndpoint: string;
  host: string;
  auth: ProviderAuth;
  additionalHeaders: Record<string, string>;
  options: ProviderRequestOptions;
};
// The models a space admin saved for editors, in order. An empty list has no
// default and allows no translation.
export type FunctionModelSettings = { models: string[]; defaultModel?: string; choices: ModelChoice[] };

export const FUNCTION_ERROR_CODES = [
  'function_not_configured',
  'profile_invalid',
  'invalid_provider_url',
  'model_list_unavailable',
  ...TRANSLATION_ERROR_CODES,
] as const;
export type FunctionErrorCode = (typeof FUNCTION_ERROR_CODES)[number];
const codes = new Set<string>(FUNCTION_ERROR_CODES);

// Contentful allows a Function 30 seconds in total. The provider deadline
// stays 3 seconds below it, leaving time to validate and return the answer.
export const FUNCTION_MAX_TIMEOUT_SECONDS = 27;
export type FunctionTimeouts = { timeoutSeconds: number; idleTimeoutSeconds: number };

export function functionErrorCode(error: unknown): FunctionErrorCode {
  return error instanceof Error && codes.has(error.message) ? (error.message as FunctionErrorCode) : 'provider_failed';
}

// The trusted profile the Function compiles with: the saved one, or the
// factory profile when none is saved. An invalid saved profile blocks
// translation until an administrator resets or replaces it.
export function functionInstructionProfile(
  context: Pick<FunctionEventContext, 'appInstallationParameters'>,
): InstructionProfile {
  try {
    return effectiveInstructionProfile(context.appInstallationParameters ?? {});
  } catch {
    throw new Error('profile_invalid');
  }
}

/**
 * The provider deadline and idle wait from installation parameters. Values
 * beyond the Function's runtime are rejected, never clamped.
 * @throws Error `function_not_configured`.
 */
export function functionTimeouts(context: Pick<FunctionEventContext, 'appInstallationParameters'>): FunctionTimeouts {
  const params = context.appInstallationParameters ?? {};
  const read = (value: unknown, fallback: number) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > FUNCTION_MAX_TIMEOUT_SECONDS)
      throw new Error('function_not_configured');
    return value;
  };
  const timeoutSeconds = read(params.functionTimeoutSeconds, FUNCTION_MAX_TIMEOUT_SECONDS);
  const idleTimeoutSeconds = read(params.functionIdleTimeoutSeconds, timeoutSeconds);
  if (idleTimeoutSeconds > timeoutSeconds) throw new Error('function_not_configured');
  return { timeoutSeconds, idleTimeoutSeconds };
}

export function functionProviderConfig(
  context: Pick<FunctionEventContext, 'appInstallationParameters'>,
): FunctionProviderConfig {
  const params = context.appInstallationParameters;
  if (
    params?.transport !== 'function' ||
    (params.functionAuthMode !== 'none' && !params.functionKeyPresent) ||
    (params.functionHeadersPresent && (typeof params.functionExtraHeaders !== 'string' || !params.functionExtraHeaders))
  ) {
    throw new Error('function_not_configured');
  }
  let base: URL;
  try {
    base = providerBaseUrl(params.functionProviderUrl);
  } catch {
    throw new Error('invalid_provider_url');
  }
  try {
    const auth = parseProviderAuth(params.functionAuthMode, params.functionApiKey, params.functionAuthHeader);
    const additionalHeaders = parseProviderHeaders(params.functionExtraHeaders);
    providerHeaders(auth, additionalHeaders);
    const options = parseProviderOptions({
      temperature: params.functionTemperature,
      topP: params.functionTopP,
      maxCompletionTokens: params.functionMaxCompletionTokens,
      outputTokenField: params.functionOutputTokenField,
      reasoningEffort: params.functionReasoningEffort,
      extraBody: params.functionExtraBody,
    });
    return {
      endpoint: providerEndpoint(params.functionProviderUrl),
      modelsEndpoint: providerModelsEndpoint(params.functionProviderUrl),
      host: base.hostname,
      auth,
      additionalHeaders,
      options,
    };
  } catch {
    throw new Error('function_not_configured');
  }
}

// The saved model list and default come from trusted installation
// parameters, so the Function enforces them.
export function functionModelSettings(
  context: Pick<FunctionEventContext, 'appInstallationParameters'>,
): FunctionModelSettings {
  const params = context.appInstallationParameters ?? {};
  try {
    return parseModelSelection(params.functionModels, params.functionDefaultModel);
  } catch {
    throw new Error('function_not_configured');
  }
}
