import { completion, envelope, signRequest, translationRequest } from '@ai-translator-for-contentful/relay-conformance';
import { HttpRequest, type HttpResponseInit } from '@azure/functions';
import { vi } from 'vitest';

export const appUrl = 'https://existing-app.example';

// The Functions HTTP request the host would pass for a Web request, with the
// app's public URL and the request's path.
export async function azureRequest(request: Request): Promise<HttpRequest> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const url = new URL(request.url);
  return new HttpRequest({
    method: request.method,
    url: `${appUrl}${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    ...(bytes.byteLength ? { body: { bytes } } : {}),
  });
}

export function fromAzure(init: HttpResponseInit): Response {
  return new Response(typeof init.body === 'string' ? init.body : null, {
    status: init.status,
    headers: init.headers as ConstructorParameters<typeof Headers>[0],
  });
}

// A Web request handler backed by an Azure handler, for the conformance suite.
export function serveAzure(handler: (request: HttpRequest) => Promise<HttpResponseInit>) {
  return async (request: Request): Promise<Response> => fromAzure(await handler(await azureRequest(request)));
}

// A signed translation for one entry at `path`.
export function signedTranslation(requestId: string, entryId: string, path = '/v1/translate'): Promise<Request> {
  return signRequest({}, envelope(translationRequest({ requestId, entryId })), path);
}

// A provider that answers only when `answer` is called, so a reservation
// stays active meanwhile.
export function heldProvider() {
  let answer = () => {};
  const held = new Promise<void>(resolve => {
    answer = resolve;
  });
  const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => {
    await held;
    return completion('Hei');
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, answer: () => answer() };
}

export async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 200) throw new Error('condition not met');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
