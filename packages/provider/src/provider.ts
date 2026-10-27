import {
  type BackendLimits,
  chatCompletionBody,
  compileTranslationMessages,
  DEFAULT_LIMITS,
  type InstructionProfile,
  MarkupError,
  mockResponseMarkup,
  type ProviderAuth,
  type ProviderRequestOptions,
  parseProviderOptions,
  RELAY_CONTRACT_VERSION,
  readTranslationResponse,
  type TranslateRequest,
  type TranslateResponse,
  utf8Bytes,
} from '@ai-translator-for-contentful/protocol';
import { ProviderError } from './errors';
import { providerHeaders } from './headers';
import { readCompletion } from './stream';

export interface ProviderConfig {
  mode: 'mock' | 'openai-compatible';
  endpoint?: string;
  auth?: ProviderAuth;
  additionalHeaders?: Record<string, string>;
  options?: ProviderRequestOptions;
  allowedModels: string[];
  // The total provider deadline from the call, unless `deadline` is given.
  timeoutMs?: number;
  // The longest wait for the first or next stream bytes, within the deadline.
  idleTimeoutMs?: number;
  trustedProfile?: InstructionProfile;
  limits?: BackendLimits;
  // Adds the model's answer to a response with a failed field.
  debug?: boolean;
}
export type TranslateOptions = {
  // The server-owned absolute deadline in epoch milliseconds.
  deadline?: number;
  signal?: AbortSignal;
};
export interface Provider {
  translate(request: TranslateRequest, options?: TranslateOptions): Promise<TranslateResponse>;
}

export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const ERROR_BODY_LIMIT = 65_536;

async function errorText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return '';
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, ERROR_BODY_LIMIT));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(bytes);
}

// A provider's rejection of a request that is too large for its context or
// body limits, so a smaller plan may succeed.
const sizeRejection =
  /context_length_exceeded|maximum context length|context window|too many tokens|request too large|payload too large|string_above_max_length/i;

async function failure(response: Response): Promise<Error> {
  const body = await errorText(response);
  const debug = { status: response.status, body };
  if (response.status === 429) return new ProviderError('provider_rate_limited', debug);
  if (response.status === 401 || response.status === 403) return new ProviderError('provider_auth_failed', debug);
  if (response.status === 413) return new ProviderError('provider_request_too_large', debug);
  if (response.status === 400 && sizeRejection.test(body))
    return new ProviderError('provider_request_too_large', debug);
  return new ProviderError('provider_failed', debug);
}

function respond(
  request: TranslateRequest,
  content: string,
  provider: TranslateResponse['provider'],
  limits: BackendLimits,
  debug = false,
): TranslateResponse {
  let results: TranslateResponse['results'];
  try {
    results = readTranslationResponse(content, request, { nodes: limits.parserNodes, depth: limits.parserDepth });
  } catch (error) {
    if (error instanceof MarkupError)
      throw new ProviderError('invalid_provider_response', { reason: error.message, answer: content });
    throw error;
  }
  const response: TranslateResponse = {
    contract: RELAY_CONTRACT_VERSION,
    requestId: request.requestId,
    provider,
    profileRevision: request.profileRevision,
    results,
  };
  if (utf8Bytes(JSON.stringify(response)) > limits.resultBytes) throw new Error('result_too_large');
  // The answer is left out when it would make the result too large.
  if (debug && results.some(result => result.status === 'failed')) {
    const withAnswer = { ...response, debug: { answer: content } };
    if (utf8Bytes(JSON.stringify(withAnswer)) <= limits.resultBytes) return withAnswer;
  }
  return response;
}

export function createProvider(config: ProviderConfig, fetcher: typeof fetch = fetch): Provider {
  const limits = config.limits ?? DEFAULT_LIMITS;
  return {
    async translate(request, options = {}) {
      if (!config.allowedModels.includes(request.model)) throw new Error('model_not_allowed');
      const profile = config.trustedProfile ?? request.profile;
      const messages = compileTranslationMessages(profile, request);
      if (config.mode === 'mock') return respond(request, mockResponseMarkup(request), 'mock', limits);
      if (!config.endpoint || !config.auth) throw new Error('provider_not_configured');
      const url = new URL(config.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
        throw new Error('invalid_provider_endpoint');
      const headers = providerHeaders(config.auth, config.additionalHeaders);
      const providerOptions = parseProviderOptions(config.options ?? {});
      const body = chatCompletionBody(request.model, messages, providerOptions);
      if (utf8Bytes(body) > limits.providerBodyBytes) throw new Error('request_too_large');
      const deadline = options.deadline ?? Date.now() + (config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const idleMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      const controller = new AbortController();
      let timedOut = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const total = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
        },
        Math.max(0, deadline - Date.now()),
      );
      // Idle time never extends the total deadline.
      const touch = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(
          () => {
            timedOut = true;
            controller.abort();
          },
          Math.max(0, Math.min(idleMs, deadline - Date.now())),
        );
      };
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      touch();
      try {
        if (Date.now() >= deadline) throw new Error('provider_timeout');
        let response: Response;
        try {
          response = await fetcher(url.href, {
            method: 'POST',
            headers: { ...headers, accept: 'text/event-stream, application/json' },
            signal: controller.signal,
            // Contentful's edge fetch supports manual redirect handling, not redirect: 'error'.
            redirect: 'manual',
            body,
          });
        } catch (error) {
          if (timedOut) throw new Error('provider_timeout');
          throw new ProviderError('provider_failed', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        touch();
        if (!response.ok) throw await failure(response);
        let content: string;
        try {
          content = await readCompletion(response, limits, touch);
        } catch (error) {
          if (timedOut) throw new Error('provider_timeout');
          // A dropped connection is an incomplete answer, never partial content.
          if (controller.signal.aborted || !(error instanceof Error) || !error.message.includes('_'))
            throw new Error('provider_incomplete');
          throw error;
        }
        return respond(request, content, 'openai-compatible', limits, config.debug);
      } finally {
        clearTimeout(total);
        if (idle) clearTimeout(idle);
        options.signal?.removeEventListener('abort', abort);
      }
    },
  };
}
