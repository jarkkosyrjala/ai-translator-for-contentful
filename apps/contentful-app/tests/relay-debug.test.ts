import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayError, signedTranslate } from '../src/app/signed';

const sdk = {
  ids: { space: 'space', environment: 'master', app: 'app' },
  cma: { appSignedRequest: { create: vi.fn(async () => ({ additionalHeaders: {} })) } },
} as unknown as Parameters<typeof signedTranslate>[0];
const request = { requestId: 'request-1' } as Parameters<typeof signedTranslate>[3];

afterEach(() => vi.unstubAllGlobals());

describe('relay debug details', () => {
  it('reads a debug relay failure as text that keeps the answer’s line breaks', async () => {
    const answer = '\n\n<field id="f-title">Hei</field>';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'invalid_provider_response',
              debug: { reason: '<field> is not allowed here.', answer },
            }),
            { status: 502 },
          ),
      ),
    );
    const error = await signedTranslate(sdk, 'https://relay.example', 'primary', request).catch(value => value);
    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ code: 'invalid_provider_response' });
    expect(error.debug).toBe(`reason: <field> is not allowed here.\nanswer:\n${answer}`);
  });

  it('has no debug details without a debug relay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_provider_response' }), { status: 502 })),
    );
    const error = await signedTranslate(sdk, 'https://relay.example', 'primary', request).catch(value => value);
    expect(error).toMatchObject({ code: 'invalid_provider_response', debug: undefined });
  });
});
