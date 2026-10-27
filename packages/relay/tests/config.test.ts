import { describe, expect, it } from 'vitest';
import {
  loadRelayConfig,
  type ModelPolicy,
  modelPermitted,
  parseRelayConfigDocument,
  type RelayConfigDocument,
  RelayConfigError,
  relayConfigRefs,
  validProviderAlias,
  validSecretRef,
} from '../src';

const example = {
  appDefinitions: {
    'example-app-a': {
      signingSecretRef: 'APP_A_SIGNING',
      previousSigningSecretRef: 'APP_A_SIGNING_OLD',
      spaces: {
        'example-space-one': ['primary', 'Self-hosted model'],
        'example-space-two': ['Self-hosted model'],
      },
    },
    'example-app-b': { signingSecretRef: 'APP_B_SIGNING', spaces: { 'example-space-three': ['primary'] } },
  },
  providers: {
    primary: {
      baseUrl: 'https://model.example/v1',
      model: 'example-model',
      authMode: 'bearer',
      credentialRef: 'MODEL_CREDENTIAL',
    },
    'Self-hosted model': {
      baseUrl: 'https://another-model.example/v1/chat/completions',
      model: 'another-example-model',
      authMode: 'header',
      authHeader: 'X-API-Key',
      credentialRef: 'SECOND_MODEL_CREDENTIAL',
      headersRef: 'SECOND_MODEL_HEADERS',
      options: { temperature: 0.2, maxCompletionTokens: 512, outputTokenField: 'max_tokens', extraBody: { seed: 1 } },
    },
  },
};
const secrets: Record<string, string> = {
  APP_A_SIGNING: 'a'.repeat(64),
  APP_A_SIGNING_OLD: 'b'.repeat(64),
  APP_B_SIGNING: 'c'.repeat(64),
  MODEL_CREDENTIAL: 'first-key',
  SECOND_MODEL_CREDENTIAL: 'second-key',
  SECOND_MODEL_HEADERS: '{"X-Provider-Version":"2026-10-01"}',
};
const text = (value: unknown = example) => JSON.stringify(value);
const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof RelayConfigError) return { path: error.path, reason: error.reason };
    throw error;
  }
  return 'parsed';
};
const edited = (edit: (config: typeof example & Record<string, unknown>) => void) => {
  const config = structuredClone(example) as typeof example & Record<string, unknown>;
  edit(config);
  return text(config);
};

describe('RELAY_CONFIG', () => {
  it('resolves the documented example with secrets from the host', () => {
    const config = loadRelayConfig(text(), ref => secrets[ref]);
    expect(config.appDefinitions.map(definition => [definition.id, definition.signingSecrets])).toEqual([
      ['example-app-a', [secrets.APP_A_SIGNING, secrets.APP_A_SIGNING_OLD]],
      ['example-app-b', [secrets.APP_B_SIGNING]],
    ]);
    expect([...config.appDefinitions[0].spaces]).toEqual(
      Object.entries(example.appDefinitions['example-app-a'].spaces),
    );
    const second = config.providers.get('Self-hosted model');
    expect(second).toMatchObject({
      model: 'another-example-model',
      host: 'another-model.example',
      config: {
        endpoint: 'https://another-model.example/v1/chat/completions',
        allowedModels: ['another-example-model'],
        auth: { mode: 'header', name: 'x-api-key', secret: 'second-key' },
        additionalHeaders: { 'X-Provider-Version': '2026-10-01' },
        options: { temperature: 0.2, maxCompletionTokens: 512, outputTokenField: 'max_tokens', extraBody: { seed: 1 } },
      },
    });
    expect(config.providers.get('primary')?.config.endpoint).toBe('https://model.example/v1/chat/completions');
  });

  it('accepts a typed object under the same rules as its serialization', () => {
    const typed = loadRelayConfig(structuredClone(example) as RelayConfigDocument, ref => secrets[ref]);
    expect(typed).toEqual(loadRelayConfig(text(), ref => secrets[ref]));
    const extra = { ...structuredClone(example), unexpected: true } as unknown as RelayConfigDocument;
    expect(failure(() => parseRelayConfigDocument(extra))).toEqual({
      path: 'RELAY_CONFIG["unexpected"]',
      reason: 'unexpected_property',
    });
    const cyclic = structuredClone(example) as unknown as RelayConfigDocument & { self?: unknown };
    cyclic.self = cyclic;
    expect(failure(() => parseRelayConfigDocument(cyclic))).toEqual({ path: 'RELAY_CONFIG', reason: 'invalid_json' });
  });

  it('lists every secret ref with its use', () => {
    expect(relayConfigRefs(parseRelayConfigDocument(text()))).toEqual([
      { ref: 'APP_A_SIGNING', use: 'signing' },
      { ref: 'APP_A_SIGNING_OLD', use: 'signing' },
      { ref: 'APP_B_SIGNING', use: 'signing' },
      { ref: 'MODEL_CREDENTIAL', use: 'credential' },
      { ref: 'SECOND_MODEL_CREDENTIAL', use: 'credential' },
      { ref: 'SECOND_MODEL_HEADERS', use: 'headers' },
    ]);
  });

  it('accepts readable aliases and host-safe secret refs only', () => {
    expect(validProviderAlias('Self-hosted model')).toBe(true);
    for (const alias of ['', ' primary', 'primary ', 'a'.repeat(101), 'tab\there', 1])
      expect(validProviderAlias(alias)).toBe(false);
    expect(validSecretRef('MODEL_CREDENTIAL_2')).toBe(true);
    for (const ref of ['model_credential', '2_KEY', 'KEY-2', 'RELAY_CONFIG', 'MOCK_TRANSLATION_ENABLED'])
      expect(validSecretRef(ref)).toBe(false);
    expect(validSecretRef('USAGE_GATE', ['USAGE_GATE'])).toBe(false);
    expect(validSecretRef('WEBSITE_NODE_DEFAULT_VERSION', ['WEBSITE_*'])).toBe(false);
    expect(validSecretRef('WEBSITE', ['WEBSITE_*'])).toBe(true);
    expect(
      failure(() =>
        parseRelayConfigDocument(
          edited(config => {
            config.providers.primary.credentialRef = 'USAGE_GATE';
          }),
          ['USAGE_GATE'],
        ),
      ),
    ).toEqual({ path: 'providers["primary"].credentialRef', reason: 'reserved_ref' });
  });

  it('names the first invalid property without a secret value', () => {
    const cases: Array<[string, { path: string; reason: string }]> = [
      ['[]', { path: 'RELAY_CONFIG', reason: 'not_an_object' }],
      [text({ ...example, providers: {} }), { path: 'providers', reason: 'empty' }],
      [text({ ...example, appDefinitions: {} }), { path: 'appDefinitions', reason: 'empty' }],
      [
        edited(config => {
          config.providers.primary.model = ' example-model';
        }),
        { path: 'providers["primary"].model', reason: 'invalid_model' },
      ],
      [
        edited(config => {
          config.providers.primary.authMode = 'basic';
        }),
        { path: 'providers["primary"].authMode', reason: 'invalid_auth' },
      ],
      [
        edited(config => {
          Object.assign(config.providers.primary, { authMode: 'none' });
        }),
        { path: 'providers["primary"].credentialRef', reason: 'unexpected_property' },
      ],
      [
        edited(config => {
          Object.assign(config.providers.primary, { authMode: 'header' });
        }),
        { path: 'providers["primary"].authHeader', reason: 'missing' },
      ],
      [
        edited(config => {
          Object.assign(config.providers.primary, { options: { seed: 1 } });
        }),
        { path: 'providers["primary"].options["seed"]', reason: 'unexpected_property' },
      ],
      [
        edited(config => {
          Object.assign(config.providers.primary, { options: { temperature: 3 } });
        }),
        { path: 'providers["primary"].options', reason: 'invalid_options' },
      ],
      [
        edited(config => {
          Object.assign(config.appDefinitions['example-app-a'], { enabled: true });
        }),
        { path: 'appDefinitions["example-app-a"]["enabled"]', reason: 'unexpected_property' },
      ],
      [
        edited(config => {
          Object.assign(config.appDefinitions, { 'bad id': config.appDefinitions['example-app-b'] });
        }),
        { path: 'appDefinitions["bad id"]', reason: 'invalid_id' },
      ],
      [
        edited(config => {
          config.appDefinitions['example-app-b'].spaces['example-space-three'] = ['Primary'];
        }),
        { path: 'appDefinitions["example-app-b"].spaces["example-space-three"][0]', reason: 'unknown_provider' },
      ],
      [
        edited(config => {
          Object.assign(config.appDefinitions['example-app-b'].spaces, { other: 'primary' });
        }),
        { path: 'appDefinitions["example-app-b"].spaces["other"]', reason: 'empty' },
      ],
    ];
    for (const [input, expected] of cases) expect(failure(() => parseRelayConfigDocument(input))).toEqual(expected);
  });

  it('validates secret values after the document', () => {
    const load = (values: Record<string, string>, config = text()) =>
      failure(() => loadRelayConfig(config, ref => values[ref]));
    expect(load({ ...secrets, MODEL_CREDENTIAL: '' })).toEqual({
      path: 'providers["primary"].credentialRef',
      reason: 'unresolved_ref',
    });
    expect(load({ ...secrets, SECOND_MODEL_HEADERS: '{"Authorization":"x"}' })).toEqual({
      path: 'providers["Self-hosted model"]',
      reason: 'invalid_provider',
    });
    expect(load({ ...secrets, APP_B_SIGNING: secrets.APP_A_SIGNING_OLD })).toEqual({
      path: 'appDefinitions["example-app-b"]',
      reason: 'shared_signing_secret',
    });
    // The same secret as both current and previous of one definition is harmless.
    expect(load({ ...secrets, APP_A_SIGNING_OLD: secrets.APP_A_SIGNING })).toBe('parsed');
    expect(JSON.stringify(load({ ...secrets, APP_B_SIGNING: secrets.APP_A_SIGNING }))).not.toContain('aaaa');
  });

  it('reads an admin-selectable alias with its model policy and the shared models endpoint', () => {
    const config = loadRelayConfig(
      edited(config => {
        const { model: _model, ...rest } = config.providers['Self-hosted model'];
        Object.assign(config.providers, {
          'Self-hosted model': { ...rest, models: { allow: ['chat-*'], deny: ['*-pro*'] } },
        });
      }),
      ref => secrets[ref],
    );
    const selectable = config.providers.get('Self-hosted model');
    expect(selectable?.model).toBeUndefined();
    expect(selectable).toMatchObject({
      host: 'another-model.example',
      modelsEndpoint: 'https://another-model.example/v1/models',
      config: { endpoint: 'https://another-model.example/v1/chat/completions', allowedModels: [] },
    });
    expect(selectable?.models && modelPermitted(selectable.models, 'chat-small')).toBe(true);
    expect(config.providers.get('primary')).toMatchObject({
      model: 'example-model',
      modelsEndpoint: 'https://model.example/v1/models',
    });
  });

  it('permits models by whole-ID, case-sensitive patterns with deny before allow', () => {
    const policy = (document: { allow?: string[]; deny?: string[] }): ModelPolicy => {
      const config = loadRelayConfig(
        edited(config => {
          const { model: _model, ...rest } = config.providers.primary;
          Object.assign(config.providers, { primary: { ...rest, models: document } });
        }),
        ref => secrets[ref],
      );
      const models = config.providers.get('primary')?.models;
      if (!models) throw new Error('missing policy');
      return models;
    };
    const denyOnly = policy({ deny: ['premium-model', '*-pro*'] });
    expect(
      ['chat-small', 'premium-model-2', 'pro-model', 'org/model:tag'].map(id => modelPermitted(denyOnly, id)),
    ).toEqual([true, true, true, true]);
    expect(
      ['premium-model', 'chat-pro', 'chat-pro-2', 'mock', '', 'bad id'].some(id => modelPermitted(denyOnly, id)),
    ).toBe(false);
    const both = policy({ allow: ['chat-*', 'exact.model'], deny: ['chat-*-preview'] });
    expect(modelPermitted(both, 'chat-')).toBe(true);
    expect(modelPermitted(both, 'chat-large')).toBe(true);
    expect(modelPermitted(both, 'Chat-large')).toBe(false);
    expect(modelPermitted(both, 'xchat-large')).toBe(false);
    expect(modelPermitted(both, 'chat-large-preview')).toBe(false);
    expect(modelPermitted(both, 'exact.model')).toBe(true);
    // A dot is literal, not any character.
    expect(modelPermitted(both, 'exactXmodel')).toBe(false);
    expect(modelPermitted(policy({}), 'any-model')).toBe(true);
    expect(modelPermitted(policy({ deny: [] }), 'any-model')).toBe(true);
    expect(modelPermitted(policy({ allow: [] }), 'any-model')).toBe(false);
    expect(modelPermitted(policy({ allow: ['*'] }), 'mock')).toBe(false);
    expect(modelPermitted(policy({ deny: ['*'] }), 'any-model')).toBe(false);
    expect(modelPermitted(policy({ allow: ['a*b*c'] }), 'axxbyyc')).toBe(true);
    expect(modelPermitted(policy({ allow: ['a*b*c'] }), 'axxbyyca')).toBe(false);
    expect(modelPermitted(policy({ allow: ['*a*a*a*a*a*a*a*a*a*b'] }), 'a'.repeat(100))).toBe(false);
  });

  it('fails closed on malformed model policies and on conflicting model settings', () => {
    const selectable = (models: unknown) =>
      edited(config => {
        const { model: _model, ...rest } = config.providers.primary;
        Object.assign(config.providers, { primary: { ...rest, models } });
      });
    const cases: Array<[string, { path: string; reason: string }]> = [
      [selectable([]), { path: 'providers["primary"].models', reason: 'not_an_object' }],
      [
        selectable({ allow: 'chat-*' }),
        { path: 'providers["primary"].models.allow', reason: 'invalid_model_patterns' },
      ],
      [
        selectable({ deny: ['ok', 'has space'] }),
        { path: 'providers["primary"].models.deny[1]', reason: 'invalid_model_pattern' },
      ],
      [selectable({ deny: [''] }), { path: 'providers["primary"].models.deny[0]', reason: 'invalid_model_pattern' }],
      [selectable({ deny: ['a?b'] }), { path: 'providers["primary"].models.deny[0]', reason: 'invalid_model_pattern' }],
      [
        selectable({ deny: Array.from({ length: 65 }, (_, index) => `m-${index}`) }),
        { path: 'providers["primary"].models.deny', reason: 'invalid_model_patterns' },
      ],
      [selectable({ block: ['x'] }), { path: 'providers["primary"].models["block"]', reason: 'unexpected_property' }],
      [
        edited(config => {
          Object.assign(config.providers.primary, { models: {} });
        }),
        { path: 'providers["primary"].models', reason: 'unexpected_property' },
      ],
      [
        edited(config => {
          const { model: _model, ...rest } = config.providers.primary;
          Object.assign(config.providers, { primary: rest });
        }),
        { path: 'providers["primary"].model', reason: 'missing' },
      ],
    ];
    for (const [input, expected] of cases) expect(failure(() => parseRelayConfigDocument(input))).toEqual(expected);
  });
});
