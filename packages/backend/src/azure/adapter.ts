import {
  AZURE_RESPONSE_SECONDS,
  azureHost,
  CLEANUP_MARGIN_MS,
  createRelayHandler,
  RelayConfigError,
  type RelayHandlerOptions,
} from '@ai-translator-for-contentful/relay';
import type { HttpMethod, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

// Every method reaches the relay, so other methods get the contract's JSON
// `404 not_found` instead of the Functions host's empty one.
export const relayMethods = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const satisfies readonly HttpMethod[];

// Setting name groups Azure reserves for the platform. A secret ref must not
// reuse one of them.
export const AZURE_RESERVED_SETTINGS: readonly string[] = [
  'FUNCTIONS_*',
  'WEBSITE_*',
  'AZURE_*',
  'APPSETTING_*',
  'APPLICATIONINSIGHTS_*',
  'SCM_*',
];

export type AzureRelayHandlerOptions = Omit<RelayHandlerOptions, 'host'> & {
  // The longest the Function App, or a proxy in front of it, waits for an
  // HTTP response, in seconds. Defaults to Azure's 230 and cannot exceed it.
  // Provider deadlines stay the 10-second cleanup margin below.
  responseSeconds?: number;
};

export type AzureRelayHandler = (request: HttpRequest, context?: InvocationContext) => Promise<HttpResponseInit>;

// With HTTP streams enabled, the body arrives as a stream, so the relay's
// bounded reader can stop an oversized body without buffering all of it.
export function toWebRequest(request: HttpRequest): Request {
  // The signature covers the exact body, so it must arrive unread.
  if (request.bodyUsed) throw new TypeError('AI Translator needs the request body unread.');
  const method = request.method.toUpperCase();
  return new Request(request.url, {
    method,
    headers: request.headers,
    body: method === 'GET' || method === 'HEAD' ? null : request.body,
    duplex: 'half',
  });
}

export async function toHttpResponseInit(response: Response): Promise<HttpResponseInit> {
  const body = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    ...(body ? { body } : {}),
  };
}

/**
 * The relay as an Azure Functions v4 HTTP handler: pass it to `app.http`, or
 * await it from a handler of your own with the request unread. Create it once
 * per worker. Registers nothing and reads no settings.
 * @throws RelayConfigError for an ambiguous `basePath` or a `responseSeconds`
 *   outside 11–230.
 */
export function createAzureRelayHandler(options: AzureRelayHandlerOptions): AzureRelayHandler {
  const { responseSeconds = AZURE_RESPONSE_SECONDS, ...relayOptions } = options;
  if (
    !Number.isInteger(responseSeconds) ||
    responseSeconds <= CLEANUP_MARGIN_MS / 1000 ||
    responseSeconds > AZURE_RESPONSE_SECONDS
  )
    throw new RelayConfigError('responseSeconds', 'invalid_response_seconds');
  const relay = createRelayHandler({
    ...relayOptions,
    reservedNames: [...AZURE_RESERVED_SETTINGS, ...(options.reservedNames ?? [])],
    host: azureHost(responseSeconds),
  });
  return async request => toHttpResponseInit(await relay(toWebRequest(request)));
}
