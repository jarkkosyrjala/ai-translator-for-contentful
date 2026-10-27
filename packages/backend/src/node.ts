import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RelayHandler } from '@ai-translator-for-contentful/relay';

export type NodeRequestListener = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

// The body as a Web stream that the relay's bounded reader pulls from, and a
// way to discard what it left unread. Discarding instead of destroying the
// socket lets the client finish sending and read a 413 answer.
function bodyOf(request: IncomingMessage): { body: ReadableStream<Uint8Array>; discard(): void } {
  let open = true;
  const discard = () => {
    open = false;
    request.resume();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      request.on('data', (chunk: Buffer) => {
        if (!open) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) request.pause();
      });
      request.once('end', () => {
        if (open) controller.close();
        open = false;
      });
      // An aborted upload closes without `end`.
      const fail = (error?: Error) => {
        if (open) controller.error(error ?? new Error('request_aborted'));
        open = false;
      };
      request.once('error', fail);
      request.once('close', () => fail());
    },
    pull() {
      request.resume();
    },
    cancel: discard,
  });
  return { body, discard };
}

// The original request target, method, headers, and raw body. HTTP/2
// pseudo-headers are not headers.
function toWebRequest(request: IncomingMessage): { webRequest: Request; discard(): void } {
  const headers = new Headers();
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2)
    if (!request.rawHeaders[index].startsWith(':'))
      headers.append(request.rawHeaders[index], request.rawHeaders[index + 1]);
  const method = request.method ?? 'GET';
  const target = request.url ?? '/';
  const { body, discard } = method === 'GET' || method === 'HEAD' ? { body: null, discard() {} } : bodyOf(request);
  // An absolute or `*` target is no relay route; it reaches the handler as `/`.
  const url = `http://localhost${target.startsWith('/') ? target : '/'}`;
  return { webRequest: new Request(url, { method, headers, body, duplex: 'half' }), discard };
}

/**
 * Connects the handler to Node's `http` or `https` server, or to a framework
 * route that passes Node's request and response. The request must arrive as
 * received: the original path, headers, and unread body that Contentful
 * signed. Mount it where nothing has read the body or rewritten `request.url`.
 */
export function createNodeRequestListener(handler: RelayHandler): NodeRequestListener {
  return async (request, response) => {
    try {
      const { webRequest, discard } = toWebRequest(request);
      const result = await handler(webRequest);
      // The relay answers some requests without reading their body.
      discard();
      const body = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, { ...Object.fromEntries(result.headers), 'content-length': body.byteLength });
      response.end(body);
    } catch {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
        response.end('{"error":"relay_unavailable"}');
      }
    }
  };
}
