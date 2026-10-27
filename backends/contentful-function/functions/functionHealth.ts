import {
  FUNCTION_LIMITS,
  type PlanningLimits,
  planningLimits,
  RELAY_CONTRACT_VERSION,
} from '@ai-translator-for-contentful/protocol';
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

export type FunctionHealthResponse =
  | {
      contract: typeof RELAY_CONTRACT_VERSION;
      status: 'ok';
      modelCall: false;
      providerConfigured: true;
      providerHost: string;
      // Empty, without a default, until a space admin saves models.
      models: string[];
      defaultModel?: string;
      // The trusted profile's revision: the saved profile's, or the factory's.
      profileRevision: string;
      // Current policy for the app's request planner.
      limits: PlanningLimits;
      timeoutSeconds: number;
    }
  | { contract: typeof RELAY_CONTRACT_VERSION; status: 'failed'; modelCall: false; errorCode: FunctionErrorCode };

// Typed by the fields the handler reads, so callers can pass just those.
export const handler = (async (
  event: Pick<AppActionRequest<'Custom', { contract: typeof RELAY_CONTRACT_VERSION }>, 'body'>,
  context: Pick<FunctionEventContext, 'appInstallationParameters'>,
): Promise<FunctionHealthResponse> => {
  try {
    if (event.body?.contract !== RELAY_CONTRACT_VERSION || Object.keys(event.body).length !== 1)
      throw new Error('unsupported_contract');
    const config = functionProviderConfig(context);
    const { models, defaultModel } = functionModelSettings(context);
    const profile = functionInstructionProfile(context);
    const { timeoutSeconds } = functionTimeouts(context);
    return {
      contract: RELAY_CONTRACT_VERSION,
      status: 'ok',
      modelCall: false,
      providerConfigured: true,
      providerHost: config.host,
      models,
      ...(defaultModel ? { defaultModel } : {}),
      profileRevision: profile.revision,
      limits: planningLimits(FUNCTION_LIMITS),
      timeoutSeconds,
    };
  } catch (error) {
    return {
      contract: RELAY_CONTRACT_VERSION,
      status: 'failed',
      modelCall: false,
      errorCode: functionErrorCode(error),
    };
  }
}) satisfies FunctionEventHandler<FunctionTypeEnum.AppActionCall>;
