import { relayInput, signRequest, translated } from '@ai-translator-for-contentful/relay-conformance';
import { HttpRequest } from '@azure/functions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayHandler, type RelayHandler, type ReservationResult, type UsageGate } from '../src';
import { createAzureRelayHandler } from '../src/azure/adapter';
import { appUrl, fromAzure, heldProvider, signedTranslation, until } from './helpers';

// A consumer's shared coordination, standing in for a store or an IPC
// coordinator several instances reach asynchronously. It keeps the rules a
// shared gate must keep: atomic reservation, one active request per entry,
// reused request IDs rejected, release of the matching reservation, expiry.
class SharedStore {
  readonly requests = new Set<string>();
  readonly active = new Map<string, { requestId: string; expires: number }>();
  gateFor = (scope: string): UsageGate => ({
    reserve: async (entryId, requestId, expiresAt): Promise<ReservationResult> => {
      await Promise.resolve();
      const key = `${scope}\u0000${entryId}`;
      if (this.requests.has(`${scope}\u0000${requestId}`)) return { ok: false, reason: 'duplicate_request' };
      const current = this.active.get(key);
      if (current && current.expires > Date.now()) return { ok: false, reason: 'concurrency_limit' };
      this.requests.add(`${scope}\u0000${requestId}`);
      this.active.set(key, { requestId, expires: expiresAt });
      return { ok: true };
    },
    release: async requestId => {
      await Promise.resolve();
      for (const [key, reservation] of this.active)
        if (key.startsWith(`${scope}\u0000`) && reservation.requestId === requestId) this.active.delete(key);
    },
  });
}

const handlerWith = (gateFor: (scope: string) => UsageGate) => {
  const input = relayInput();
  return createRelayHandler({ config: input.config, secret: ref => input.secrets[ref], gateFor });
};

describe('consumer-supplied shared gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coordinates two handler instances: same entry excluded, replay rejected, other entries proceed', async () => {
    const store = new SharedStore();
    const [first, second] = [handlerWith(store.gateFor), handlerWith(store.gateFor)];
    const provider = heldProvider();
    const replayed = await signedTranslation('a1', 'entry-a');
    const pending = first(replayed.clone());
    await until(() => provider.fetcher.mock.calls.length === 1);
    const busy = await second(await signedTranslation('b1', 'entry-a'));
    expect({ status: busy.status, body: await busy.json() }).toEqual({
      status: 429,
      body: { error: 'concurrency_limit' },
    });
    const other = second(await signedTranslation('c1', 'entry-b'));
    await until(() => provider.fetcher.mock.calls.length === 2);
    provider.answer();
    expect((await pending).status).toBe(200);
    expect((await other).status).toBe(200);
    expect(store.active.size).toBe(0);
    const replay = await second(replayed);
    expect({ status: replay.status, body: await replay.json() }).toEqual({
      status: 429,
      body: { error: 'duplicate_request' },
    });
    expect(await (await second(await signedTranslation('a2', 'entry-a'))).json()).toEqual(translated('a2', 'Hei'));
  });

  it('serves the same gate through the Azure handler', async () => {
    const store = new SharedStore();
    const input = relayInput();
    const azure = createAzureRelayHandler({
      config: input.config,
      secret: ref => input.secrets[ref],
      gateFor: store.gateFor,
    });
    const generic = handlerWith(store.gateFor);
    const provider = heldProvider();
    const pending = generic(await signedTranslation('a1', 'entry-a'));
    await until(() => provider.fetcher.mock.calls.length === 1);
    const signed = await signedTranslation('b1', 'entry-a');
    const busy = await azure(
      new HttpRequest({
        method: 'POST',
        url: `${appUrl}/v1/translate`,
        headers: Object.fromEntries(signed.headers),
        body: { string: await signed.text() },
      }),
    );
    expect(fromAzure(busy).status).toBe(429);
    provider.answer();
    expect((await pending).status).toBe(200);
  });
});

// A platform that delivers HTTP requests as events. The consumer's adapter
// carries the method, path, headers and raw body across and converts the
// answer back; the package needs no knowledge of the platform.
type PlatformEvent = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
};
type PlatformResult = { statusCode: number; headers: Record<string, string>; body: string };

function toWebRequest(event: PlatformEvent): Request {
  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  return new Request(`https://platform.example${event.path}`, {
    method: event.method,
    headers: event.headers,
    body: event.method === 'GET' || event.method === 'HEAD' ? null : body,
  });
}

async function toPlatformResult(response: Response): Promise<PlatformResult> {
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}

describe('serverless event adapter', () => {
  const input = relayInput(undefined, { mockTranslation: true });
  const handler: RelayHandler = createRelayHandler({
    config: input.config,
    secret: ref => input.secrets[ref],
    mockTranslation: true,
    basePath: '/fn/translator',
  });
  const invoke = async (event: PlatformEvent) => toPlatformResult(await handler(toWebRequest(event)));
  async function eventOf(request: Request, isBase64Encoded: boolean): Promise<PlatformEvent> {
    const bytes = Buffer.from(await request.arrayBuffer());
    return {
      method: request.method,
      path: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
      body: bytes.toString(isBase64Encoded ? 'base64' : 'utf8'),
      isBase64Encoded,
    };
  }

  it('serves health and translation from text and base64 event bodies', async () => {
    for (const isBase64Encoded of [false, true]) {
      const health = await invoke(
        await eventOf(await signRequest({}, undefined, '/fn/translator/v1/health'), isBase64Encoded),
      );
      expect(health.statusCode).toBe(200);
      const translation = await invoke(
        await eventOf(
          await signedTranslation(`r-${isBase64Encoded}`, 'entry-a', '/fn/translator/v1/translate'),
          isBase64Encoded,
        ),
      );
      expect({ status: translation.statusCode, body: JSON.parse(translation.body) }).toEqual({
        status: 200,
        body: translated(`r-${isBase64Encoded}`, 'Hello [fi-FI example]', 'mock'),
      });
    }
  });
});
