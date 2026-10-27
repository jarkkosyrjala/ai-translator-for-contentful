import { RELAY_CONTRACT_VERSION } from '@ai-translator-for-contentful/protocol';
import { listProviderModels } from '@ai-translator-for-contentful/provider';
import type {
  AppActionRequest,
  FunctionEventContext,
  FunctionEventHandler,
  FunctionTypeEnum,
} from '@contentful/node-apps-toolkit';
import { type FunctionErrorCode, functionErrorCode, functionProviderConfig } from './config';

export type FunctionModelsResponse =
  | { contract: typeof RELAY_CONTRACT_VERSION; status: 'ok'; modelCall: false; models: string[] }
  | { contract: typeof RELAY_CONTRACT_VERSION; status: 'failed'; modelCall: false; errorCode: FunctionErrorCode };

// Lists the provider's model IDs with the saved URL, credential, and headers
// so a space admin can choose models. The caller supplies nothing else, and no
// model is called.
export const handler = (async (
  event: Pick<AppActionRequest<'Custom', { contract: typeof RELAY_CONTRACT_VERSION }>, 'body'>,
  context: Pick<FunctionEventContext, 'appInstallationParameters'>,
): Promise<FunctionModelsResponse> => {
  try {
    if (event.body?.contract !== RELAY_CONTRACT_VERSION || Object.keys(event.body).length !== 1)
      throw new Error('unsupported_contract');
    const config = functionProviderConfig(context);
    const models = await listProviderModels({
      endpoint: config.modelsEndpoint,
      auth: config.auth,
      additionalHeaders: config.additionalHeaders,
      timeoutMs: 20_000,
    });
    return { contract: RELAY_CONTRACT_VERSION, status: 'ok', modelCall: false, models };
  } catch (error) {
    return {
      contract: RELAY_CONTRACT_VERSION,
      status: 'failed',
      modelCall: false,
      errorCode: functionErrorCode(error),
    };
  }
}) satisfies FunctionEventHandler<FunctionTypeEnum.AppActionCall>;
