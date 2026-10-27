import type { AppState, ContentTypeField, EditorInterface } from '@contentful/app-sdk';
import { describe, expect, it } from 'vitest';
import {
  choiceKey,
  dialogChoiceLabel,
  effectiveRelayChoices,
  parseRelayChoices,
  relayChoiceProblems,
  relayChoicesError,
  serializeRelayChoices,
} from '../src/app/choices';
import type { EditorSnapshot } from '../src/app/editor-snapshot';
import {
  backendHealthMessage,
  backendUrlError,
  buildTargetState,
  connectionErrorMessage,
  countTranslatableFields,
  dialogRelayChoices,
  relaySaveError,
  setupErrors,
} from '../src/app/setup-model';
import { isConfigured, outcomeLine, readinessLine, readyFieldCount } from '../src/app/sidebar-model';
import { RelayError } from '../src/app/signed';

const fields = [
  { id: 'title', name: 'Title', type: 'Symbol', localized: true },
  { id: 'tags', name: 'Tags', type: 'Array', localized: true, items: { type: 'Symbol' } },
  { id: 'choice', name: 'Choice', type: 'Symbol', localized: true },
  { id: 'count', name: 'Count', type: 'Integer', localized: true },
] as ContentTypeField[];
const controls = [
  { fieldId: 'title', widgetNamespace: 'builtin', widgetId: 'singleLine' },
  { fieldId: 'tags', widgetNamespace: 'builtin', widgetId: 'listInput' },
  { fieldId: 'choice', widgetNamespace: 'builtin', widgetId: 'checkbox' },
] as EditorInterface['controls'];

const primary = { alias: 'primary', model: 'test-model', host: 'model.example', timeoutSeconds: 600 };
const second = {
  alias: 'Self-hosted model',
  model: 'another-model',
  host: 'another.example',
  timeoutSeconds: 600,
};
const selectable = {
  alias: 'Admin selects',
  host: 'model.example',
  timeoutSeconds: 200,
  modelSelection: 'installation' as const,
};
const health = {
  contract: 1 as const,
  status: 'ok' as const,
  modelCall: false as const,
  providerConfigured: true,
  providers: [primary, second, selectable],
  limits: { requestBytes: 2_097_152, providerBodyBytes: 4_194_304, resultBytes: 4_194_304 },
};
const saved = (choices: { alias: string; model?: string }[], relayProvider = '', relayModel = '') => ({
  backendUrl: 'https://relay.example',
  relayProviderChoices: serializeRelayChoices(choices),
  relayProvider,
  relayModel,
});

describe('Custom backend editor choices', () => {
  it('parses saved choices strictly', () => {
    expect(parseRelayChoices(undefined)).toEqual([]);
    expect(parseRelayChoices('[{"alias":"primary"},{"alias":"Admin selects","model":"chat-small"}]')).toEqual([
      { alias: 'primary' },
      { alias: 'Admin selects', model: 'chat-small' },
    ]);
    for (const value of [
      '{',
      '{}',
      '[{"alias":""}]',
      '[{"alias":"primary","extra":1}]',
      '[{"alias":"primary","model":"mock"}]',
      '[{"alias":"primary","model":"bad id"}]',
      '[{"alias":"primary"},{"alias":"primary"}]',
      '[{"alias":"x","model":"a"},{"alias":"x","model":"a"}]',
      '[{"alias":"x"},{"alias":"x","model":"a"}]',
    ])
      expect(() => parseRelayChoices(value)).toThrow('invalid_choices');
  });
  it('requires a nonempty list that contains the exact default', () => {
    expect(relayChoicesError(saved([]))).toMatch(/at least one/);
    expect(relayChoicesError({ ...saved([]), relayProviderChoices: '[' })).toMatch(/could not be read/);
    expect(relayChoicesError(saved([{ alias: 'primary' }], 'primary'))).toBeUndefined();
    expect(relayChoicesError(saved([{ alias: 'primary' }]))).toMatch(/Choose the default/);
    // A selectable default needs its model; a fixed default must not have one.
    const models = [{ alias: 'Admin selects', model: 'chat-small' }];
    expect(relayChoicesError(saved(models, 'Admin selects', 'chat-small'))).toBeUndefined();
    expect(relayChoicesError(saved(models, 'Admin selects'))).toMatch(/Choose the default/);
    expect(relayChoicesError(saved([{ alias: 'primary' }], 'primary', 'test-model'))).toMatch(/Choose the default/);
  });
  it('offers only saved choices that health honors, in health order, keeping two models of one alias distinct', () => {
    const list = [
      { alias: 'Admin selects', model: 'chat-small', translationSettings: { requestSourceCharacters: 5_000 } },
      { alias: 'primary' },
      { alias: 'Admin selects', model: 'chat-large' },
      { alias: 'removed' },
    ];
    expect(effectiveRelayChoices(health.providers, list)).toEqual([
      { key: '["primary"]', alias: 'primary', model: 'test-model', host: 'model.example', timeoutSeconds: 600 },
      {
        key: '["Admin selects","chat-small"]',
        alias: 'Admin selects',
        model: 'chat-small',
        host: 'model.example',
        timeoutSeconds: 200,
        translationSettings: { requestSourceCharacters: 5_000 },
      },
      {
        key: '["Admin selects","chat-large"]',
        alias: 'Admin selects',
        model: 'chat-large',
        host: 'model.example',
        timeoutSeconds: 200,
      },
    ]);
    // Settings round-trip with the saved choice and are validated strictly.
    expect(parseRelayChoices(serializeRelayChoices(list))).toEqual(list);
    expect(() =>
      parseRelayChoices(JSON.stringify([{ alias: 'primary', translationSettings: { retrySizeFactor: 1 } }])),
    ).toThrow('invalid_choices');
    expect(dialogChoiceLabel(effectiveRelayChoices(health.providers, list)[1])).toBe(
      'Admin selects · chat-small · model.example',
    );
    // A new alias stays out until an admin checks it.
    expect(effectiveRelayChoices(health.providers, [{ alias: 'primary' }]).map(choice => choice.alias)).toEqual([
      'primary',
    ]);
  });
  it('flags removed aliases and changed selection modes for explicit repair', () => {
    const list = [
      { alias: 'primary', model: 'test-model' },
      { alias: 'Admin selects' },
      { alias: 'removed' },
      { alias: second.alias },
    ];
    expect(relayChoiceProblems(health.providers, list)).toEqual([
      { choice: list[0], reason: 'mode' },
      { choice: list[1], reason: 'mode' },
      { choice: list[2], reason: 'missing' },
    ]);
    expect(effectiveRelayChoices(health.providers, list).map(choice => choice.alias)).toEqual([second.alias]);
  });
  it('blocks saving until problems are removed and the default is offered, never switching it', () => {
    expect(relaySaveError(undefined, { backendUrl: '' })).toBeUndefined();
    expect(relaySaveError(undefined, saved([]))).toMatch(/at least one/);
    // Without health, a syntactically valid list can be saved again.
    expect(relaySaveError(undefined, saved([{ alias: 'removed' }], 'removed'))).toBeUndefined();
    expect(relaySaveError(health, saved([{ alias: 'removed' }, { alias: 'primary' }], 'primary'))).toMatch(
      /no longer offers/,
    );
    expect(relaySaveError(health, saved([{ alias: 'primary' }, { alias: second.alias }], 'primary'))).toBeUndefined();
    expect(relaySaveError(health, saved([{ alias: 'primary' }, { alias: second.alias }]))).toMatch(
      /Choose the default/,
    );
  });
  it('starts a dialog at the saved default or blocks generation', () => {
    const list = [{ alias: 'primary' }, { alias: 'Admin selects', model: 'chat-large' }];
    expect(dialogRelayChoices(health, saved(list, 'Admin selects', 'chat-large'))).toEqual({
      choices: effectiveRelayChoices(health.providers, list),
      defaultKey: choiceKey({ alias: 'Admin selects', model: 'chat-large' }),
    });
    expect(dialogRelayChoices({ ...health, providers: [primary] }, saved(list, 'Admin selects', 'chat-large'))).toEqual(
      {
        problem: expect.stringMatching(/“Admin selects · chat-large” is no longer available/),
      },
    );
    expect(dialogRelayChoices({ ...health, providerConfigured: false }, saved(list, 'primary'))).toEqual({
      problem: expect.stringMatching(/no translation provider/),
    });
  });
});

describe('setup choices and validation', () => {
  it('counts only fields the editor can translate', () => {
    expect(countTranslatableFields(fields, controls)).toBe(2);
  });
  it('preserves unrelated location settings and existing sidebar position', () => {
    const current = {
      EditorInterface: {
        page: {
          sidebar: { position: 4, settings: { key: 'keep' } },
          controls: [{ fieldId: 'title', settings: { example: true } }],
        },
        article: { sidebar: { position: 2 }, editors: { position: 1 } },
        hidden: { sidebar: { position: 3 } },
      },
    } as AppState;
    const choices = [
      { id: 'page', name: 'Page', translatableFields: 2 },
      { id: 'article', name: 'Article', translatableFields: 1 },
      { id: 'product', name: 'Product', translatableFields: 1, sidebarPosition: 6 },
    ];
    const next = buildTargetState(current, choices, new Set(['page', 'product']));
    expect(next.EditorInterface.page).toEqual(current.EditorInterface.page);
    expect(next.EditorInterface.article).toEqual({ editors: { position: 1 } });
    expect(next.EditorInterface.product).toEqual({ sidebar: { position: 6 } });
    expect(next.EditorInterface.hidden).toEqual(current.EditorInterface.hidden);
    expect(current.EditorInterface.article.sidebar).toEqual({ position: 2 });
    expect(buildTargetState(current, choices, new Set(), new Set()).EditorInterface).toEqual(current.EditorInterface);
  });
  it('rejects malformed settings but allows empty untested settings', () => {
    expect(backendUrlError('http://worker.example')).toMatch(/HTTPS/);
    expect(backendUrlError('https://worker.example/?code=key')).toMatch(/without a query/);
    expect(backendUrlError('https://worker.example/api//translator')).toMatch(/without empty segments/);
    expect(backendUrlError('https://worker.example/api/ai%20translator')).toMatch(/letters, digits/);
    expect(backendUrlError('https://worker.example')).toBeUndefined();
    expect(backendUrlError('https://functions.example/api/ai-translator')).toBeUndefined();
    expect(backendUrlError('https://functions.example/api/ai-translator/')).toBeUndefined();
    expect(setupErrors({ transport: 'custom', backendUrl: '' })).toEqual({
      backendUrl: undefined,
      functionProviderUrl: undefined,
    });
    expect(setupErrors({ transport: 'custom', backendUrl: 'invalid' })).toMatchObject({
      backendUrl: expect.any(String),
    });
  });
  it('turns health and transport failures into actionable language', () => {
    expect(backendHealthMessage({ ...health, providerConfigured: false }).text).toMatch(/no translation provider/);
    expect(backendHealthMessage(health).text).toMatch(/No model was called/);
    const signature = connectionErrorMessage(new RelayError(401, 'invalid_signature'), 'custom').text;
    expect(signature).toMatch(/signing secret/);
    expect(signature).toMatch(/RELAY_CONFIG does not list this space/);
    expect(connectionErrorMessage(new RelayError(503, 'relay_misconfigured'), 'custom').text).toMatch(
      /validate RELAY_CONFIG/,
    );
    expect(connectionErrorMessage(new TypeError('Failed to fetch'), 'custom').text).toMatch(/could not be reached/);
    expect(connectionErrorMessage(new RelayError(400, 'unsupported_contract'), 'custom').text).toMatch(
      /another version of the translator contract/,
    );
  });
});

describe('entry sidebar copy', () => {
  const snapshot: EditorSnapshot = {
    entryId: 'entry',
    contentTypeId: 'page',
    defaultLocale: 'en-US',
    locales: ['en-US', 'fi-FI', 'sv-SE'],
    controls,
    definitions: fields,
    fields: {
      title: { 'en-US': 'Hello' },
      tags: { 'en-US': ['Red'] },
      choice: { 'en-US': 'Yes' },
      count: { 'en-US': 3 },
    },
  };
  const names = { 'en-US': 'English', 'fi-FI': 'Finnish', 'sv-SE': 'Swedish' };
  it('uses current values, eligibility and locale names for readiness', () => {
    expect(readyFieldCount(snapshot, 'en-US')).toBe(2);
    expect(readinessLine(snapshot, names)).toBe('2 fields can be translated into Finnish and Swedish.');
    expect(
      readyFieldCount(
        { ...snapshot, fields: { ...snapshot.fields, title: { 'en-US': '' }, tags: { 'en-US': [] } } },
        'en-US',
      ),
    ).toBe(0);
    expect(isConfigured({ transport: 'custom', ...saved([{ alias: 'primary' }], 'primary') })).toBe(true);
    // The default alone, as saved before editor choices existed, is not enough.
    expect(isConfigured({ transport: 'custom', backendUrl: 'https://relay.example', relayProvider: 'primary' })).toBe(
      false,
    );
    expect(
      isConfigured({
        transport: 'custom',
        ...saved([{ alias: 'primary' }], 'primary'),
        backendUrl: 'http://relay.example',
      }),
    ).toBe(false);
    const fn = {
      transport: 'function' as const,
      functionProviderUrl: 'https://provider.example.com/v1',
      functionKeyPresent: true,
    };
    const models = (...ids: string[]) => JSON.stringify(ids.map(model => ({ model })));
    expect(isConfigured({ ...fn, functionModels: '[]' })).toBe(false);
    expect(isConfigured({ ...fn, functionModels: models('mock'), functionDefaultModel: 'mock' })).toBe(false);
    expect(isConfigured({ ...fn, functionModels: models('test-model') })).toBe(false);
    expect(isConfigured({ ...fn, functionModels: models('test-model'), functionDefaultModel: 'test-model' })).toBe(
      true,
    );
    // A bare model ID list is an earlier format and is not read.
    expect(isConfigured({ ...fn, functionModels: '["test-model"]', functionDefaultModel: 'test-model' })).toBe(false);
  });
  it('uses field and language names for all outcome statuses', () => {
    expect(outcomeLine({ key: 'title:fi-FI', status: 'applied' }, fields, names)).toBe('Title · Finnish · written');
    expect(outcomeLine({ key: 'title:sv-SE', status: 'conflict' }, fields, names)).toBe(
      'Title · Swedish · not written, Swedish changed in the editor',
    );
    for (const status of [
      'kept',
      'invalid',
      'denied',
      'disabled',
      'failed',
      'generation_failed',
      'cancelled',
      'not_generated',
    ]) {
      const line = outcomeLine({ key: 'tags:fi-FI', status }, fields, names);
      expect(line).toContain('Tags · Finnish · ');
      expect(line).not.toContain('tags:fi-FI');
    }
  });
});
