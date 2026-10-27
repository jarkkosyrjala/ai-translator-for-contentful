import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createMemoryUsageGate,
  describeRelayConformance,
  envelope,
  relayInput,
  signRequest,
  translationRequest,
} from '@ai-translator-for-contentful/relay-conformance';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryGates, createRelayHandler, type RelayHandler } from '../src';
import { createNodeRequestListener } from '../src/node';
import { until } from './helpers';

const prefix = '/translator';
// One server for every case. Each handler a case creates gets an ID that its
// requests carry in an unsigned header, so concurrent cases stay apart.
const handlers = new Map<string, RelayHandler>();
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request, response) => {
    const handler = handlers.get(String(request.headers['x-test-handler']));
    if (handler) return createNodeRequestListener(handler)(request, response);
    response.writeHead(500).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

function register(handler: RelayHandler): string {
  const id = String(handlers.size + 1);
  handlers.set(id, handler);
  return id;
}

// Sends a Web request through Node's HTTP client, without the global fetch
// that cases stub for the provider.
async function send(id: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = Buffer.from(await request.arrayBuffer());
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...Object.fromEntries(request.headers), 'x-test-handler': id, 'content-length': body.byteLength },
      },
      incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
          const status = incoming.statusCode ?? 0;
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          resolve(new Response(status === 204 ? null : Buffer.concat(chunks), { status, headers }));
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

// Writes `size` bytes in chunks without a declared length, and resolves with
// the answer even when the server stops reading and closes.
function sendChunked(id: string, request: Request, size: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(request.headers);
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: new URL(request.url).pathname,
        headers: { ...headers, 'x-test-handler': id },
      },
      incoming => {
        let body = '';
        incoming.on('data', chunk => {
          body += chunk;
        });
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
      },
    );
    outgoing.on('error', error => (outgoing.destroyed ? undefined : reject(error)));
    const chunk = Buffer.alloc(64 * 1024, 'x');
    let sent = 0;
    const write = () => {
      while (sent < size) {
        sent += chunk.byteLength;
        if (!outgoing.write(chunk)) return outgoing.once('drain', write);
      }
      outgoing.end();
    };
    write();
  });
}

describeRelayConformance('Node listener beneath a base path', {
  createGates: () => () => createMemoryUsageGate(),
  createHandler: ({ config, secrets, mockTranslation, gateFor }) => {
    const id = register(
      createRelayHandler({ config, secret: ref => secrets[ref], mockTranslation, gateFor, basePath: prefix }),
    );
    return request => send(id, request);
  },
  basePath: prefix,
});

describe('Node listener', () => {
  const input = relayInput(undefined, { mockTranslation: true });
  const relay = createRelayHandler({
    config: input.config,
    secret: ref => input.secrets[ref],
    mockTranslation: true,
    gateFor: createMemoryGates(),
    basePath: prefix,
  });

  it('passes the exact Unicode body and full path the signature covers', async () => {
    const id = register(relay);
    const body = `{ "extra" : true,\n\t"contract": 1, "note": "Hyvää päivää 🌍" }`;
    expect((await send(id, await signRequest({}, body, `${prefix}/v1/health`))).status).toBe(200);
    const source = '  Hyvää päivää, maailma 🌍\n';
    const translation = envelope(
      translationRequest({ fields: [{ id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source }] }),
    );
    const response = await send(id, await signRequest({}, translation, `${prefix}/v1/translate`));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('Hyvää päivää, maailma 🌍');
    const root = await signRequest();
    expect((await send(id, new Request(`https://relay.example${prefix}/v1/health`, root))).status).toBe(401);
  });

  it('answers 413 to an oversized streamed body instead of resetting the connection', async () => {
    const id = register(relay);
    const signed = await signRequest({}, '', `${prefix}/v1/translate`);
    expect(await sendChunked(id, signed, 3 * 1024 * 1024)).toEqual({ status: 413, body: '{"error":"too_large"}' });
    // The server keeps serving.
    expect((await send(id, await signRequest({}, undefined, `${prefix}/v1/health`))).status).toBe(200);
  });

  it('finishes a request whose client disconnects during the body', async () => {
    const finished = vi.fn();
    const id = register(async request => {
      try {
        return await relay(request);
      } finally {
        finished();
      }
    });
    const signed = await signRequest({}, '', `${prefix}/v1/translate`);
    const outgoing = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `${prefix}/v1/translate`,
      headers: { ...Object.fromEntries(signed.headers), 'x-test-handler': id, 'content-length': 1000 },
    });
    outgoing.on('error', () => undefined);
    outgoing.write('{"provider":');
    await new Promise(resolve => setTimeout(resolve, 50));
    outgoing.destroy();
    await until(() => finished.mock.calls.length === 1);
  });

  it('answers other targets with the contract errors', async () => {
    const id = register(relay);
    expect((await send(id, new Request(`https://relay.example${prefix}/v1/health`))).status).toBe(404);
    const preflight = await send(id, new Request(`https://relay.example${prefix}/v1/translate`, { method: 'OPTIONS' }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    const absolute = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `http://other.example${prefix}/v1/health`,
          headers: { 'x-test-handler': id },
        },
        incoming => {
          incoming.resume();
          resolve(incoming.statusCode ?? 0);
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(absolute).toBe(404);
  });

  it('answers relay_unavailable when the handler fails', async () => {
    const id = register(async () => {
      throw new Error('broken');
    });
    const response = await send(id, await signRequest({}, undefined, `${prefix}/v1/health`));
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 502,
      body: { error: 'relay_unavailable' },
    });
  });
});
