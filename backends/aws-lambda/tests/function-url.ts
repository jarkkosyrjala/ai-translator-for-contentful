import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';
import type { ActiveReservations, CommitResult, GateSnapshot, GateStore } from '../src/usage-gate';

// Builds the event a function URL delivers for this request: payload format
// 2.0 with lowercase, comma-joined headers. A UTF-8 body arrives as text and
// any other body base64-encoded; the adapter accepts both.
export async function toEvent(request: Request): Promise<LambdaFunctionURLEvent> {
  const url = new URL(request.url);
  const bytes = new Uint8Array(await request.arrayBuffer());
  let body: string | undefined;
  let isBase64Encoded = false;
  if (bytes.byteLength) {
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      body = Buffer.from(bytes).toString('base64');
      isBase64Encoded = true;
    }
  }
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(request.headers),
    requestContext: {
      accountId: '123456789012',
      apiId: 'example',
      domainName: url.host,
      domainPrefix: 'example',
      http: {
        method: request.method,
        path: url.pathname,
        protocol: 'HTTP/1.1',
        sourceIp: '192.0.2.1',
        userAgent: 'conformance',
      },
      requestId: 'example-request',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2026:12:00:00 +0000',
      timeEpoch: Date.now(),
    },
    body,
    isBase64Encoded,
  };
}

// The HTTP response a function URL sends for this result.
export function toResponse(result: APIGatewayProxyStructuredResultV2): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers ?? {})) headers.set(name, String(value));
  return new Response(result.body || null, { status: result.statusCode, headers });
}

// In-memory store with the same atomic commit semantics as the DynamoDB store.
export function createMemoryGateStore(): GateStore {
  const seen = new Set<string>();
  let version = 0;
  let active: ActiveReservations = new Map();
  return {
    async read(requestId): Promise<GateSnapshot> {
      return { version, active, seen: seen.has(requestId) };
    },
    async commit(requestId, expected, next): Promise<CommitResult> {
      if (seen.has(requestId)) return 'duplicate';
      if (expected !== version) return 'conflict';
      seen.add(requestId);
      version++;
      active = new Map(next);
      return 'committed';
    },
    async remove(requestId) {
      if (!active.has(requestId)) return;
      const next = new Map(active);
      next.delete(requestId);
      active = next;
      version++;
    },
  };
}
