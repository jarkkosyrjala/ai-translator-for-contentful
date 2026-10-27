import type { ContentTypeField, EditorInterface, FieldAppSDK } from '@contentful/app-sdk';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChooseScreen } from '../src/app/dialog/ChooseScreen';
import { launchedField } from '../src/app/dialog/model';
import { editorDialogType } from '../src/app/editor-dialogs';
import { capture, type EditorSnapshot } from '../src/app/editor-snapshot';
import { eligibility, fieldAppEditor, resolveAppControls } from '../src/app/eligibility';
import { fieldAction } from '../src/app/field-model';
import { openTranslator } from '../src/app/launch';
import { dialogInvocation } from '../src/app/live-snapshot';
import { countTranslatableFields } from '../src/app/setup-model';
import { outcomeNotice } from '../src/app/sidebar-model';

const field = (id: string, type: ContentTypeField['type'], extra: Partial<ContentTypeField> = {}) =>
  ({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    type,
    localized: true,
    required: false,
    validations: [],
    ...extra,
  }) as ContentTypeField;
const fields = [
  field('title', 'Symbol'),
  field('body', 'Text'),
  field('story', 'RichText'),
  field('tags', 'Array', { items: { type: 'Symbol' } }),
  field('count', 'Integer'),
];
const app = (fieldId: string, settings?: Record<string, unknown>) =>
  ({ fieldId, widgetNamespace: 'app', widgetId: 'translator-app', ...(settings ? { settings } : {}) }) as NonNullable<
    EditorInterface['controls']
  >[number];
const names = { 'en-US': 'English', 'fi-FI': 'Finnish', 'sv-SE': 'Swedish' };

describe('entry field location', () => {
  it('renders Contentful’s default editor unless the instance parameter picks another one for the field type', () => {
    expect(fieldAppEditor(field('title', 'Symbol'))).toBe('singleLine');
    expect(fieldAppEditor(field('body', 'Text'))).toBe('markdown');
    expect(fieldAppEditor(field('body', 'Text'), { editor: 'multipleLine' })).toBe('multipleLine');
    expect(fieldAppEditor(field('story', 'RichText'), { editor: 'markdown' })).toBe('richTextEditor');
    expect(fieldAppEditor(field('tags', 'Array', { items: { type: 'Symbol' } }))).toBe('tagEditor');
    expect(fieldAppEditor(field('tags', 'Array', { items: { type: 'Symbol' } }), { editor: 'listInput' })).toBe(
      'listInput',
    );
    expect(fieldAppEditor(field('title', 'Symbol'), { editor: 'markdown' })).toBe('singleLine');
    expect(fieldAppEditor(field('count', 'Integer'))).toBeUndefined();
  });

  it('treats fields edited by this app like the built-in editor it renders, and other apps as unknown', () => {
    const controls = [
      app('title'),
      app('body', { editor: 'multipleLine' }),
      app('tags', { editor: 'listInput' }),
      { fieldId: 'story', widgetNamespace: 'app', widgetId: 'other-app' },
    ] as EditorInterface['controls'];
    const resolved = resolveAppControls(controls, fields, 'translator-app');
    expect(resolved).toEqual([
      { fieldId: 'title', widgetNamespace: 'builtin', widgetId: 'singleLine' },
      { fieldId: 'body', widgetNamespace: 'builtin', widgetId: 'multipleLine', settings: { editor: 'multipleLine' } },
      { fieldId: 'tags', widgetNamespace: 'builtin', widgetId: 'listInput', settings: { editor: 'listInput' } },
      { fieldId: 'story', widgetNamespace: 'app', widgetId: 'other-app' },
    ]);
    expect(fields.slice(0, 4).map(item => eligibility(item, resolved).eligible)).toEqual([true, true, false, true]);
    expect(resolveAppControls(controls, fields, undefined)).toBe(controls);
    expect(countTranslatableFields(fields, controls)).toBe(0);
    expect(countTranslatableFields(fields, controls, 'translator-app')).toBe(3);
  });

  it('resolves app controls in the live snapshot the dialog and Apply use', () => {
    const sdk = {
      contentType: { fields: [fields[0]] },
      locales: { available: ['en-US'], default: 'en-US' },
      ids: { entry: 'entry', contentType: 'page', app: 'translator-app' },
      editor: {
        getLocaleSettings: () => ({ mode: 'single', focused: 'en-US' }),
        editorInterface: { controls: [app('title')] },
      },
      entry: { fields: { title: { locales: ['en-US'], getValue: () => 'Hello' } } },
    } as unknown as FieldAppSDK;
    expect(capture(sdk).controls).toEqual([{ fieldId: 'title', widgetNamespace: 'builtin', widgetId: 'singleLine' }]);
  });

  it('passes the launching field and locale to the dialog and fixes them only while they remain translatable', () => {
    const snapshot: EditorSnapshot = {
      entryId: 'entry',
      contentTypeId: 'page',
      defaultLocale: 'en-US',
      locales: ['en-US', 'fi-FI'],
      fields: { title: { 'en-US': 'Hello' } },
      definitions: fields,
      controls: [{ fieldId: 'tags', widgetNamespace: 'builtin', widgetId: 'tagEditor' }],
    };
    expect(dialogInvocation(snapshot, 'session', { fieldId: 'title', locale: 'fi-FI' })).toEqual({
      entryId: 'entry',
      contentTypeId: 'page',
      sessionId: 'session',
      fieldId: 'title',
      sourceLocale: 'fi-FI',
    });
    expect(launchedField(snapshot, 'title', 'fi-FI')).toEqual({ field: fields[0], locale: 'fi-FI' });
    expect(launchedField(snapshot, 'title', 'sv-SE')).toBeUndefined();
    expect(launchedField(snapshot, 'count', 'en-US')).toBeUndefined();
    expect(launchedField(snapshot, 'missing', 'en-US')).toBeUndefined();
    expect(launchedField(snapshot, undefined, undefined)).toBeUndefined();
  });

  it('shows a fixed source language and field instead of the pickers', () => {
    const snapshot: EditorSnapshot = {
      entryId: 'entry',
      contentTypeId: 'page',
      defaultLocale: 'en-US',
      locales: ['en-US', 'fi-FI'],
      fields: { title: { 'fi-FI': 'Punainen talo' } },
      definitions: fields,
      controls: [],
    };
    const props = {
      snapshot,
      localeNames: names,
      source: 'fi-FI',
      onSource: () => {},
      saveDefault: false,
      onSaveDefault: () => {},
      canSaveDefault: true,
      targets: ['en-US'],
      onTarget: () => {},
      saveTargetDefault: false,
      onSaveTargetDefault: () => {},
      canSaveTargetDefault: true,
      fields: ['title'],
      eligibleFields: [fields[0]],
      onField: () => {},
      onSelectAll: () => {},
      guidance: '',
      onGuidance: () => {},
      selectedContext: [],
      contextCandidates: [],
      onContext: () => {},
      contextKey: () => '',
      sentContext: [],
      search: '',
      onSearch: () => {},
      hits: [],
      onLoadEntry: () => {},
      contextStatus: '',
      planned: [],
      planWarnings: [],
      destination: '',
      model: 'model',
      transport: 'custom' as const,
      choices: [],
      onChoice: () => {},
      saveChoiceDefault: false,
      onSaveChoiceDefault: () => {},
      canSaveChoiceDefault: true,
      variableValues: {},
      onVariableValue: () => {},
    };
    const fixed = renderToStaticMarkup(React.createElement(ChooseScreen, { ...props, launchField: fields[0] }));
    expect(fixed).toContain('Translate from</strong> Finnish');
    expect(fixed).toContain('Punainen talo');
    expect(fixed).not.toContain('id="source-locale"');
    expect(fixed).not.toContain('name="field-title"');
    expect(fixed).not.toContain('Select all');
    const open = renderToStaticMarkup(React.createElement(ChooseScreen, props));
    expect(open).toContain('id="source-locale"');
    expect(open).toContain('name="field-title"');
    expect(open).not.toContain('Sends to');
    // A Custom backend dialog names its provider and model; other choices stay
    // under collapsed Advanced settings.
    const primary = { key: '["primary"]', alias: 'primary', model: 'test-model', host: 'model.example' };
    const small = { key: '["Admin","chat-small"]', alias: 'Admin', model: 'chat-small', host: 'model.example' };
    const large = { key: '["Admin","chat-large"]', alias: 'Admin', model: 'chat-large', host: 'model.example' };
    const single = renderToStaticMarkup(
      React.createElement(ChooseScreen, { ...props, choice: primary, choices: [primary] }),
    );
    expect(single).toContain('Sends to <strong>primary</strong>');
    expect(single).toContain('test-model');
    expect(single).not.toContain('Advanced settings');
    expect(single).not.toContain('name="save-choice"');
    const several = renderToStaticMarkup(
      React.createElement(ChooseScreen, { ...props, choice: large, choices: [primary, small, large] }),
    );
    expect(several).toContain('<details class="dialog-advanced">');
    expect(several).toContain('Provider and model');
    expect(several).toContain('name="save-choice"');
    expect(several).toContain('Admin · chat-small · model.example');
    expect(several).toContain('Admin · chat-large · model.example');
    expect(several).toContain(`value="${large.key.replaceAll('"', '&quot;')}" selected=""`);
    // The Function names the model and offers other saved models as Model.
    const fnChoice = (model: string) => ({ key: model, model, host: 'provider.example.com' });
    const fn = renderToStaticMarkup(
      React.createElement(ChooseScreen, {
        ...props,
        transport: 'function',
        choice: fnChoice('model-a'),
        choices: [fnChoice('model-a'), fnChoice('model-b')],
      }),
    );
    expect(fn).toContain('Sends to <strong>model-a</strong>');
    expect(fn).toContain('provider.example.com');
    expect(fn).toContain('>Model</label>');
    expect(fn).toContain('>model-b</option>');
  });

  it('offers the translate button only for translatable fields and says why it is disabled', () => {
    const base = {
      result: eligibility(fields[0], []),
      fieldName: 'Title',
      value: 'Hello',
      locale: 'en-US',
      targets: ['fi-FI'],
      configured: true,
      localeNames: names,
    };
    expect(fieldAction(base)).toEqual({
      visible: true,
      label: 'Translate Title from English',
      tooltip: 'Translate from English',
      disabled: false,
    });
    expect(fieldAction({ ...base, value: '  ' })).toMatchObject({
      visible: true,
      disabled: true,
      tooltip: 'Add text in English to translate it.',
    });
    expect(fieldAction({ ...base, configured: false })).toMatchObject({
      visible: true,
      disabled: true,
      tooltip: expect.stringContaining('isn’t set up'),
    });
    expect(fieldAction({ ...base, targets: [] })).toEqual({ visible: false });
    expect(fieldAction({ ...base, result: eligibility(field('title', 'Symbol', { localized: false }), []) })).toEqual({
      visible: false,
    });
    expect(fieldAction({ ...base, result: undefined })).toEqual({ visible: false });
  });

  it('summarizes a field run in one notification', () => {
    expect(outcomeNotice([], fields, names)).toBeUndefined();
    expect(
      outcomeNotice(
        [
          { key: 'title:fi-FI', status: 'applied' },
          { key: 'title:sv-SE', status: 'kept' },
        ],
        fields,
        names,
      ),
    ).toEqual({ variant: 'success', message: '1 value written to the draft. Nothing was published.' });
    expect(
      outcomeNotice(
        [
          { key: 'title:fi-FI', status: 'applied' },
          { key: 'title:sv-SE', status: 'conflict' },
        ],
        fields,
        names,
      ),
    ).toEqual({
      variant: 'warning',
      message:
        '1 value written to the draft. Nothing was published. Title · Swedish · not written, Swedish changed in the editor.',
    });
  });

  it('routes Contentful editor helper dialogs away from the translator', () => {
    expect(editorDialogType({ type: 'markdown-insertLink' })).toBe('markdown');
    expect(editorDialogType({ type: 'rich-text-hyperlink-dialog' })).toBe('richText');
    expect(editorDialogType({ entryId: 'entry', sessionId: 'session' })).toBeUndefined();
    expect(editorDialogType(undefined)).toBeUndefined();
  });

  it('opens the dialog for the launching field, writes accepted values, and stops serving the snapshot', async () => {
    const values: Record<string, unknown> = { 'en-US': 'Hello', 'fi-FI': null };
    const stop = vi.fn();
    const setValue = vi.fn(async (value: unknown, locale: string) => {
      values[locale] = value;
    });
    let invocation: unknown;
    let dialogOptions: { width?: string; minHeight?: string } | undefined;
    const sdk = {
      contentType: { fields: [fields[0]] },
      locales: { available: ['en-US', 'fi-FI'], default: 'en-US' },
      ids: { entry: 'entry', contentType: 'page', app: 'translator-app', space: 'space', environment: 'env' },
      editor: {
        getLocaleSettings: () => ({ mode: 'single', focused: 'en-US' }),
        editorInterface: { controls: [app('title')] },
      },
      entry: {
        fields: {
          title: {
            locales: ['en-US', 'fi-FI'],
            getValue: (locale: string) => values[locale],
            setValue,
            getForLocale: () => ({ getIsDisabled: () => false }),
            onValueChanged: () => stop,
          },
        },
      },
      access: { can: async () => true },
      dialogs: {
        openCurrentApp: async (options: { parameters: unknown; width?: string; minHeight?: string }) => {
          dialogOptions = options;
          invocation = options.parameters;
          return {
            choice: 'suggestion',
            outcomes: [],
            accepted: [
              {
                entryId: 'entry',
                fieldId: 'title',
                kind: 'text',
                sourceLocale: 'en-US',
                targetLocale: 'fi-FI',
                sourceSnapshot: 'Hello',
                targetSnapshot: null,
                dependencies: [],
                suggestion: 'Hei',
              },
            ],
          };
        },
      },
    } as unknown as FieldAppSDK;
    const lines = await openTranslator(sdk, { fieldId: 'title', locale: 'en-US' });
    expect(dialogOptions).toMatchObject({ width: 'fullscreen', minHeight: 'calc(100vh - 89px)' });
    expect(invocation).toMatchObject({
      entryId: 'entry',
      contentTypeId: 'page',
      fieldId: 'title',
      sourceLocale: 'en-US',
    });
    expect(setValue).toHaveBeenCalledWith('Hei', 'fi-FI');
    expect(lines).toEqual([{ key: 'title:fi-FI', status: 'applied', detail: undefined }]);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('does not write a suggestion whose context changed while the launcher checked permissions', async () => {
    const values: Record<string, Record<string, unknown>> = {
      title: { 'en-US': 'Hello', 'fi-FI': null },
      body: { 'en-US': 'Sent as context', 'fi-FI': null },
    };
    const setValue = vi.fn(async () => undefined);
    const entryField = (id: string) => ({
      locales: ['en-US', 'fi-FI'],
      getValue: (locale: string) => values[id][locale],
      setValue,
      getForLocale: () => ({ getIsDisabled: () => false }),
      onValueChanged: () => () => {},
    });
    const accepted = {
      entryId: 'entry',
      fieldId: 'title',
      kind: 'text',
      sourceLocale: 'en-US',
      targetLocale: 'fi-FI',
      sourceSnapshot: 'Hello',
      targetSnapshot: null,
      dependencies: [{ fieldId: 'body', locale: 'en-US', value: 'Sent as context' }],
      suggestion: 'Hei',
    };
    let returned: Record<string, unknown> = accepted;
    const sdk = {
      contentType: { fields: [fields[0], fields[1]] },
      locales: { available: ['en-US', 'fi-FI'], default: 'en-US' },
      ids: { entry: 'entry', contentType: 'page', app: 'translator-app', space: 'space', environment: 'env' },
      editor: {
        getLocaleSettings: () => ({ mode: 'single', focused: 'en-US' }),
        editorInterface: { controls: [app('title')] },
      },
      entry: { fields: { title: entryField('title'), body: entryField('body') } },
      access: {
        can: async () => {
          values.body['en-US'] = 'Edited during Apply';
          return true;
        },
      },
      dialogs: { openCurrentApp: async () => ({ choice: 'suggestion', accepted: [returned] }) },
    } as unknown as FieldAppSDK;
    expect(await openTranslator(sdk)).toMatchObject([{ key: 'title:fi-FI', status: 'conflict' }]);
    // A result without its dependencies is not a valid selection.
    const { dependencies: _omitted, ...withoutDependencies } = accepted;
    returned = withoutDependencies;
    expect(await openTranslator(sdk)).toMatchObject([{ status: 'invalid' }]);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('passes reviewed text warning approval through the shared launch path', async () => {
    const setValue = vi.fn(async () => undefined);
    let warningApproved = false;
    const sdk = {
      contentType: { fields: [fields[1]] },
      locales: { available: ['en-US', 'fi-FI'], default: 'en-US' },
      ids: { entry: 'entry', contentType: 'page', app: 'translator-app', space: 'space', environment: 'env' },
      editor: { getLocaleSettings: () => ({ mode: 'single', focused: 'en-US' }), editorInterface: { controls: [] } },
      entry: {
        fields: {
          body: {
            locales: ['en-US', 'fi-FI'],
            getValue: (locale: string) => (locale === 'en-US' ? 'Use order_id' : null),
            setValue,
            getForLocale: () => ({ getIsDisabled: () => false }),
            onValueChanged: () => () => {},
          },
        },
      },
      access: { can: async () => true },
      dialogs: {
        openCurrentApp: async () => ({
          choice: 'suggestion',
          accepted: [
            {
              entryId: 'entry',
              fieldId: 'body',
              kind: 'text',
              sourceLocale: 'en-US',
              targetLocale: 'fi-FI',
              sourceSnapshot: 'Use order_id',
              targetSnapshot: null,
              dependencies: [],
              suggestion: 'Käytä HUOM order_id',
              warningApproved,
            },
          ],
        }),
      },
    } as unknown as FieldAppSDK;
    expect(await openTranslator(sdk)).toMatchObject([{ status: 'invalid' }]);
    expect(setValue).not.toHaveBeenCalled();
    warningApproved = true;
    expect(await openTranslator(sdk)).toMatchObject([{ status: 'applied' }]);
    expect(setValue).toHaveBeenCalledExactlyOnceWith('Käytä HUOM order_id', 'fi-FI');
  });

  it('passes reviewed Rich Text warning approval through the shared launch path', async () => {
    const rich = (value: string) => ({
      nodeType: 'document',
      data: {},
      content: [{ nodeType: 'paragraph', data: {}, content: [{ nodeType: 'text', value, marks: [], data: {} }] }],
    });
    const source = rich('Use order_id');
    const suggestion = rich('Käytä tilaus_id');
    const setValue = vi.fn(async () => undefined);
    let warningApproved = false;
    const sdk = {
      contentType: { fields: [fields[2]] },
      locales: { available: ['en-US', 'fi-FI'], default: 'en-US' },
      ids: { entry: 'entry', contentType: 'page', app: 'translator-app', space: 'space', environment: 'env' },
      editor: { getLocaleSettings: () => ({ mode: 'single', focused: 'en-US' }), editorInterface: { controls: [] } },
      entry: {
        fields: {
          story: {
            locales: ['en-US', 'fi-FI'],
            getValue: (locale: string) => (locale === 'en-US' ? source : null),
            setValue,
            getForLocale: () => ({ getIsDisabled: () => false }),
            onValueChanged: () => () => {},
          },
        },
      },
      access: { can: async () => true },
      dialogs: {
        openCurrentApp: async () => ({
          choice: 'suggestion',
          accepted: [
            {
              entryId: 'entry',
              fieldId: 'story',
              kind: 'richText',
              sourceLocale: 'en-US',
              targetLocale: 'fi-FI',
              sourceSnapshot: source,
              targetSnapshot: null,
              dependencies: [],
              suggestion,
              warningApproved,
            },
          ],
        }),
      },
    } as unknown as FieldAppSDK;
    expect(await openTranslator(sdk)).toMatchObject([{ status: 'invalid' }]);
    expect(setValue).not.toHaveBeenCalled();
    warningApproved = true;
    expect(await openTranslator(sdk)).toMatchObject([{ status: 'applied' }]);
    expect(setValue).toHaveBeenCalledExactlyOnceWith(suggestion, 'fi-FI');
  });
});
