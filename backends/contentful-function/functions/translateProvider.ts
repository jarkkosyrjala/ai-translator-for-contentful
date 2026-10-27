import {
  FUNCTION_LIMITS,
  parseTranslateRequest,
  RELAY_CONTRACT_VERSION,
  type TranslateRequest,
  type TranslateResponse,
} from '@ai-translator-for-contentful/protocol';
import { createProvider } from '@ai-translator-for-contentful/provider';
import type {
  AppActionRequest,
  FunctionEventContext,
  FunctionEventHandler,
  FunctionTypeEnum,
} from '@contentful/node-apps-toolkit';
import {
  type FunctionErrorCode,
  functionErrorCode,
  functionInstructionProfile,
  functionModelSettings,
  functionProviderConfig,
  functionTimeouts,
} from './config';

export type FunctionTranslateResult =
  | TranslateResponse
  | { contract: typeof RELAY_CONTRACT_VERSION; requestId: string; errorCode: FunctionErrorCode };

// Typed by the fields the handler reads, so callers can pass just those.
export const handler = (async (
  event: Pick<AppActionRequest<'Custom', TranslateRequest>, 'body'>,
  context: Pick<FunctionEventContext, 'appInstallationParameters'>,
): Promise<FunctionTranslateResult> => {
  // The deadline counts from invocation, inside Contentful's total limit.
  const started = Date.now();
  const requestId =
    typeof event.body?.requestId === 'string' && event.body.requestId.length <= 100 ? event.body.requestId : '';
  try {
    const request = parseTranslateRequest(event.body, FUNCTION_LIMITS.requestBytes);
    const config = functionProviderConfig(context);
    // Only a model the space admin saved; `mock` is never a valid saved ID.
    if (!functionModelSettings(context).models.includes(request.model)) throw new Error('model_not_allowed');
    // The installed profile is trusted; the request only names its revision.
    const trustedProfile = functionInstructionProfile(context);
    if (request.profileRevision !== trustedProfile.revision) throw new Error('invalid_request');
    const { timeoutSeconds, idleTimeoutSeconds } = functionTimeouts(context);
    return await createProvider({
      mode: 'openai-compatible',
      endpoint: config.endpoint,
      auth: config.auth,
      additionalHeaders: config.additionalHeaders,
      options: config.options,
      trustedProfile,
      allowedModels: [request.model],
      idleTimeoutMs: idleTimeoutSeconds * 1000,
      limits: FUNCTION_LIMITS,
    }).translate(request, { deadline: started + timeoutSeconds * 1000 });
  } catch (error) {
    return { contract: RELAY_CONTRACT_VERSION, requestId, errorCode: functionErrorCode(error) };
  }
}) satisfies FunctionEventHandler<FunctionTypeEnum.AppActionCall>;
