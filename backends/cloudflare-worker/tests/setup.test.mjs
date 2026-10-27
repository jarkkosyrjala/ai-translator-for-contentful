import { parseRelayConfigDocument, relayConfigRefs, resolveRelayConfig } from '@ai-translator-for-contentful/relay';
import { describe, expect, it } from 'vitest';
import * as setup from '../scripts/setup-model.mjs';
import { WORKER_BINDINGS } from '../src/worker';

const provider = (model, credentialRef) => ({
  baseUrl: `https://${model}.example/v1`,
  model,
  authMode: 'bearer',
  credentialRef,
});

function firstRun() {
  let config = setup.addProvider(
    setup.emptyConfig(),
    'primary',
    provider('first', setup.newRef('credential', setup.emptyConfig())),
  );
  config = setup.addAppDefinition(config, 'app-a', setup.newRef('signing', config), 'space-one', ['primary']);
  return config;
}

describe('Cloudflare relay setup', () => {
  it('builds a valid first configuration with refs the relay reads', () => {
    const config = firstRun();
    const document = parseRelayConfigDocument(JSON.stringify(config), setup.WORKER_BINDINGS);
    expect(setup.configRefs(config)).toEqual(relayConfigRefs(document));
    expect(setup.configRefs(config)).toEqual([
      { ref: 'CONTENTFUL_SIGNING_SECRET_1', use: 'signing' },
      { ref: 'PROVIDER_CREDENTIAL_1', use: 'credential' },
    ]);
    expect(setup.WORKER_BINDINGS).toEqual(WORKER_BINDINGS);
  });

  it('names new secrets around those the Worker already has', () => {
    expect(setup.newRef('signing', firstRun(), ['CONTENTFUL_SIGNING_SECRET_2'])).toBe('CONTENTFUL_SIGNING_SECRET_3');
    expect(setup.newRef('headers', firstRun())).toBe('PROVIDER_HEADERS_1');
  });

  it('adds spaces, App Definitions, and providers without changing the input', () => {
    const first = firstRun();
    let config = setup.addProvider(first, 'Self-hosted model', provider('second', 'PROVIDER_CREDENTIAL_2'));
    config = setup.setSpace(config, 'app-a', 'space-two', ['Self-hosted model', 'primary']);
    config = setup.addAppDefinition(config, 'app-b', 'CONTENTFUL_SIGNING_SECRET_2', 'space-one', ['primary']);
    expect(first.appDefinitions['app-a'].spaces).toEqual({ 'space-one': ['primary'] });
    expect(() => setup.addAppDefinition(config, 'app-b', 'X', 'space', ['primary'])).toThrow('already listed');
    expect(() => setup.setSpace(config, 'app-a', 'space', [])).toThrow('at least one provider');
    expect(() => setup.setSpace(config, 'app-a', 'space', ['missing'])).toThrow('not configured');
    expect(() => setup.setSpace(config, 'app-a', 'space', ['primary', 'primary'])).toThrow('once');
    expect(() => setup.removeProvider(config, 'primary')).toThrow('allows only “primary”');
    const fewer = setup.removeProvider(
      setup.removeSpace(setup.removeAppDefinition(config, 'app-b'), 'app-a', 'space-one'),
      'primary',
    );
    expect(fewer.appDefinitions).toEqual({
      'app-a': {
        signingSecretRef: 'CONTENTFUL_SIGNING_SECRET_1',
        spaces: { 'space-two': ['Self-hosted model'] },
      },
    });
    expect(() => setup.removeAppDefinition(fewer, 'app-a')).toThrow('at least one App Definition');
    parseRelayConfigDocument(JSON.stringify(fewer), setup.WORKER_BINDINGS);
  });

  it('rotates a signing secret through the previous ref and deletes the old binding only afterwards', () => {
    const config = firstRun();
    const rotating = setup.startRotation(config, 'app-a', 'CONTENTFUL_SIGNING_SECRET_2');
    expect(rotating.appDefinitions['app-a']).toMatchObject({
      signingSecretRef: 'CONTENTFUL_SIGNING_SECRET_2',
      previousSigningSecretRef: 'CONTENTFUL_SIGNING_SECRET_1',
    });
    expect(() => setup.startRotation(rotating, 'app-a', 'CONTENTFUL_SIGNING_SECRET_3')).toThrow('Finish');
    const managed = setup.configRefs(rotating).map(item => item.ref);
    const bound = [...managed, 'UNRELATED_SECRET'];
    expect(setup.obsoleteRefs(managed, rotating, bound)).toEqual([]);
    const finished = setup.finishRotation(rotating, 'app-a');
    expect(finished.appDefinitions['app-a'].previousSigningSecretRef).toBeUndefined();
    expect(setup.obsoleteRefs(managed, finished, bound)).toEqual(['CONTENTFUL_SIGNING_SECRET_1']);
    expect(() => setup.finishRotation(finished, 'app-a')).toThrow('no signing-secret rotation');
  });

  it('asks only for unbound secrets and validates the rest with placeholders', () => {
    const config = setup.addProvider(firstRun(), 'headers', {
      ...provider('third', 'PROVIDER_CREDENTIAL_2'),
      headersRef: 'PROVIDER_HEADERS_1',
    });
    expect(setup.unboundRefs(config, ['CONTENTFUL_SIGNING_SECRET_1', 'PROVIDER_CREDENTIAL_1'])).toEqual([
      { ref: 'PROVIDER_CREDENTIAL_2', use: 'credential' },
      { ref: 'PROVIDER_HEADERS_1', use: 'headers' },
    ]);
    const twoDefinitions = setup.addAppDefinition(config, 'app-b', 'CONTENTFUL_SIGNING_SECRET_2', 'space', ['headers']);
    const document = parseRelayConfigDocument(JSON.stringify(twoDefinitions));
    const uses = new Map(relayConfigRefs(document).map(item => [item.ref, item.use]));
    expect(() => resolveRelayConfig(document, ref => setup.placeholderSecret(ref, uses.get(ref)))).not.toThrow();
  });

  it('generates 64-character alphanumeric signing secrets without bias', () => {
    expect(setup.generateSigningSecret()).toMatch(/^[A-Za-z0-9]{64}$/);
    // Bytes from 248 up are skipped so each character is equally likely.
    let calls = 0;
    const secret = setup.generateSigningSecret(count => {
      calls++;
      return new Uint8Array(count).map((_, index) => (calls === 1 && index % 2 ? 255 : 1));
    });
    expect(secret).toBe('B'.repeat(64));
    expect(calls).toBe(2);
  });

  it('reads the workers.dev URL from deploy output', () => {
    expect(
      setup.deployedUrl(
        'Uploaded ai-translator (2.1 sec)\n  https://ai-translator.example-account.workers.dev\nCurrent Version ID: x',
      ),
    ).toBe('https://ai-translator.example-account.workers.dev');
    expect(setup.deployedUrl('No URL')).toBeUndefined();
  });

  it('adds a model at an existing provider with its credential and kept or replaced options', () => {
    const base = setup.addProvider(firstRun(), 'tuned', {
      ...provider('first', 'PROVIDER_CREDENTIAL_1'),
      headersRef: 'PROVIDER_HEADERS_1',
      options: { temperature: 0.2 },
    });
    const kept = setup.addModelAtProvider(base, 'tuned', 'Second model', 'second-model');
    expect(kept.providers['Second model']).toEqual({
      baseUrl: 'https://first.example/v1',
      authMode: 'bearer',
      credentialRef: 'PROVIDER_CREDENTIAL_1',
      headersRef: 'PROVIDER_HEADERS_1',
      model: 'second-model',
      options: { temperature: 0.2 },
    });
    const replaced = setup.addModelAtProvider(base, 'tuned', 'Reasoning', 'reasoner', { reasoningEffort: 'low' });
    expect(replaced.providers.Reasoning.options).toEqual({ reasoningEffort: 'low' });
    expect(setup.addModelAtProvider(base, 'tuned', 'Plain', 'plain', null).providers.Plain).not.toHaveProperty(
      'options',
    );
    // No new secret: both aliases name the same refs.
    expect(
      setup.unboundRefs(
        kept,
        setup.configRefs(base).map(item => item.ref),
      ),
    ).toEqual([]);
    expect(setup.aliasesUsingRef(kept, 'PROVIDER_CREDENTIAL_1', 'tuned')).toEqual(['primary', 'Second model']);
    expect(() => setup.addModelAtProvider(base, 'missing', 'x', 'y')).toThrow('not configured');
    expect(() => setup.addModelAtProvider(base, 'tuned', 'primary', 'y')).toThrow('already exists');
    parseRelayConfigDocument(JSON.stringify(replaced), setup.WORKER_BINDINGS);
    // The relay's option parser rejects replacement options it cannot send.
    expect(() =>
      parseRelayConfigDocument(
        JSON.stringify(setup.addModelAtProvider(base, 'tuned', 'Bad', 'bad', { temperature: 9 })),
        setup.WORKER_BINDINGS,
      ),
    ).toThrow('invalid_options');
  });

  it('keeps a shared credential binding until no alias names it', () => {
    let config = setup.addModelAtProvider(firstRun(), 'primary', 'Second model', 'second-model');
    config = setup.setSpace(config, 'app-a', 'space-one', ['primary', 'Second model']);
    const managed = setup.configRefs(config).map(item => item.ref);
    const fewer = setup.removeProvider(config, 'Second model');
    expect(setup.obsoleteRefs(managed, fewer, managed)).toEqual([]);
  });

  it('writes deny-only and allow/deny model policies the relay accepts', () => {
    expect(setup.patternList(' premium-model, *-pro* ,')).toEqual(['premium-model', '*-pro*']);
    expect(setup.patternList('  ')).toBeUndefined();
    expect(setup.modelPolicy(undefined, undefined)).toEqual({});
    const denyOnly = setup.modelPolicy(undefined, ['premium-model', '*-pro*']);
    const both = setup.modelPolicy(['chat-*'], ['*-preview']);
    expect(denyOnly).toEqual({ deny: ['premium-model', '*-pro*'] });
    expect(both).toEqual({ allow: ['chat-*'], deny: ['*-preview'] });
    let config = firstRun();
    for (const [alias, models] of [
      ['Deny only', denyOnly],
      ['Allow and deny', both],
    ])
      config = setup.addProvider(config, alias, {
        baseUrl: 'https://first.example/v1',
        authMode: 'bearer',
        credentialRef: 'PROVIDER_CREDENTIAL_1',
        models,
      });
    const document = parseRelayConfigDocument(JSON.stringify(config), setup.WORKER_BINDINGS);
    expect(document.providers['Allow and deny'].models).toEqual(both);
    expect(setup.summary(config)).toContain(
      'Allow and deny: models chosen by space admins at first.example (allow chat-*; deny *-preview)',
    );
    expect(setup.summary(config)).toContain('primary: first at first.example');
    expect(() =>
      parseRelayConfigDocument(
        JSON.stringify(
          setup.addProvider(firstRun(), 'Bad', {
            baseUrl: 'https://first.example/v1',
            authMode: 'none',
            models: setup.modelPolicy(undefined, ['bad pattern']),
          }),
        ),
      ),
    ).toThrow('invalid_model_pattern');
  });

  it('names the aliases a listed space gains', () => {
    const before = setup.addProvider(firstRun(), 'second', provider('second', 'PROVIDER_CREDENTIAL_2'));
    const after = setup.addAppDefinition(
      setup.setSpace(before, 'app-a', 'space-one', ['primary', 'second']),
      'app-b',
      'CONTENTFUL_SIGNING_SECRET_2',
      'space-two',
      ['primary'],
    );
    expect(setup.addedAliases(before, after)).toEqual(['second', 'primary']);
    expect(setup.addedAliases(after, after)).toEqual([]);
  });
});
