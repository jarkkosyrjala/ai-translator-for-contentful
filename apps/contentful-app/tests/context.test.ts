import {
  DEFAULT_LIMITS,
  defaultInstructionProfile,
  resolveTranslationSettings,
} from '@ai-translator-for-contentful/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../src/app/batch';
import { boundContext } from '../src/app/context';
import { planRun } from '../src/app/planner';
import { loadSavedEntry, searchSavedEntries } from '../src/app/saved-context';
import { relayEnvelope, signedTranslate } from '../src/app/signed';

const profile = defaultInstructionProfile();
const task: Task = {
  key: 'title:fi-FI',
  entryId: 'open',
  fieldId: 'title',
  fieldName: 'Title',
  kind: 'text',
  longText: false,
  order: 0,
  sourceLocale: 'en-US',
  targetLocale: 'fi-FI',
  sourceSnapshot: 'Leave the line',
  targetSnapshot: null,
  definition: { id: 'title', name: 'Title', type: 'Symbol', localized: true, required: false },
};
const budget = { maxFields: 8, fieldCharacters: 2_000, totalCharacters: 6_000 };
const plan = (change: { runGuidance?: string; explicit?: Parameters<typeof boundContext>[0] } = {}) =>
  planRun([task], {
    settings: resolveTranslationSettings({}, 20_000),
    limits: {
      requestBytes: DEFAULT_LIMITS.requestBytes,
      providerBodyBytes: DEFAULT_LIMITS.providerBodyBytes,
      resultBytes: DEFAULT_LIMITS.resultBytes,
    },
    model: 'test-model',
    profile,
    runGuidance: change.runGuidance ?? '',
    variableValues: {},
    availableLocales: ['en-US', 'fi-FI'],
    explicitContext: change.explicit ?? [],
    envelope: request => relayEnvelope('primary', request),
    id: () => 'preview-id',
  });

describe('request preview composition', () => {
  it('sends the exact previewed request and keeps current versus saved provenance', async () => {
    const [preview] = plan({
      runGuidance: 'Keep a calm tone.',
      explicit: [
        {
          entryId: 'open',
          fieldId: 'summary',
          fieldName: 'Summary',
          locale: 'en-US',
          provenance: 'current-editor',
          rawValue: 'Unsaved editor copy',
        },
        {
          entryId: 'other',
          fieldId: 'tagline',
          fieldName: 'Tagline',
          locale: 'fi-FI',
          provenance: 'saved-entry',
          rawValue: 'Saved Finnish copy',
          savedVersion: 4,
        },
      ],
    }).requests;
    expect(preview.request.context).toEqual([
      {
        id: 'ctx-1',
        role: 'explicit',
        entryId: 'open',
        fieldId: 'summary',
        name: 'Summary',
        locale: 'en-US',
        provenance: 'current-editor',
        omittedUnits: 0,
        value: 'Unsaved editor copy',
      },
      {
        id: 'ctx-2',
        role: 'explicit',
        entryId: 'other',
        fieldId: 'tagline',
        name: 'Tagline',
        locale: 'fi-FI',
        provenance: 'saved-entry',
        version: 4,
        omittedUnits: 0,
        value: 'Saved Finnish copy',
      },
    ]);
    expect(preview.request).toMatchObject({ contract: 1, entryId: 'open', runGuidance: 'Keep a calm tone.' });
    expect(preview.messages[1].content).toContain('provenance="saved-entry" version="4"');
    // The current-editor context value is a dependency; saved context is labeled instead.
    expect(preview.dependencies.map(item => `${item.fieldId}:${item.locale}`)).toEqual([
      'title:en-US',
      'title:fi-FI',
      'summary:en-US',
    ]);
    const actual: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      actual.push(String(init?.body));
      return new Response(
        JSON.stringify({
          contract: 1,
          requestId: 'preview-id',
          provider: 'openai-compatible',
          profileRevision: profile.revision,
          results: [{ id: 'f-title', status: 'ok', type: 'text', text: 'Ei enää jonossa odottamista' }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const sdk = {
        ids: { space: 'space', environment: 'master', app: 'app' },
        cma: {
          appSignedRequest: { create: vi.fn(async () => ({ additionalHeaders: { 'x-test-signature': 'redacted' } })) },
        },
      };
      const response = await signedTranslate(
        sdk as unknown as Parameters<typeof signedTranslate>[0],
        'https://relay.example',
        'primary',
        preview.request,
      );
      expect(actual).toEqual([JSON.stringify({ provider: 'primary', request: preview.request })]);
      expect(new TextEncoder().encode(actual[0]).length).toBe(preview.bytes);
      expect(actual[0]).not.toContain('x-test-signature');
      expect(response.results[0]).toMatchObject({ text: 'Ei enää jonossa odottamista' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('omits whole context units and records the omission before sending', () => {
    const { items } = boundContext(
      [
        {
          entryId: 'open',
          fieldId: 'body',
          fieldName: 'Body',
          locale: 'en-US',
          provenance: 'current-editor',
          rawValue: `First paragraph.\n\n${'x'.repeat(2100)}\n\nLast paragraph.`,
        },
      ],
      budget,
    );
    expect(items[0].value).toBe('First paragraph.\n\nLast paragraph.');
    expect(items[0].omittedUnits).toBe(1);
    expect(items[0].value).not.toContain('xxx');
  });

  it('keeps array positions, counts code points and replaces characters a reader cannot accept', () => {
    const { items } = boundContext(
      [
        {
          entryId: 'open',
          fieldId: 'tags',
          fieldName: 'Tags',
          locale: 'en-US',
          provenance: 'current-editor',
          rawValue: ['One', ' ', 'Three\u0007'],
        },
      ],
      { ...budget, fieldCharacters: 30 },
    );
    expect(items[0].value).toBe('Item 1: One\n\nItem 3: Three�');
  });

  it('rejects overlong guidance and too many selected fields before Generate', () => {
    expect(() => plan({ runGuidance: 'x'.repeat(1001) })).toThrow('could not be prepared');
    const item = {
      entryId: 'open',
      fieldId: 'a',
      fieldName: 'A',
      locale: 'en-US',
      provenance: 'current-editor' as const,
      rawValue: 'Value',
    };
    expect(() => plan({ explicit: Array.from({ length: 9 }, () => item) })).toThrow('at most 8');
  });

  it('loads other-entry context only from the saved entry in the current environment', async () => {
    const sdk = {
      ids: { space: 'free-space', environment: 'master' },
      cma: {
        entry: {
          getMany: vi.fn(async () => ({
            items: [
              {
                sys: { id: 'other', contentType: { sys: { id: 'page' } } },
                fields: { title: { 'en-US': 'Saved title' } },
              },
            ],
          })),
          get: vi.fn(async () => ({
            sys: { id: 'other', version: 7, contentType: { sys: { id: 'page' } } },
            fields: { title: { 'en-US': 'Saved title' } },
          })),
        },
        contentType: {
          get: vi.fn(async () => ({ fields: [{ id: 'title', name: 'Title', localized: true, type: 'Symbol' }] })),
        },
      },
    };
    const reader = sdk as unknown as Parameters<typeof loadSavedEntry>[0];
    expect(await searchSavedEntries(reader, 'Saved')).toEqual([
      { id: 'other', contentTypeId: 'page', label: 'Saved title' },
    ]);
    const saved = await loadSavedEntry(reader, 'other');
    expect(saved).toMatchObject({ id: 'other', version: 7, fields: { title: { 'en-US': 'Saved title' } } });
    expect(sdk.cma.entry.get).toHaveBeenCalledWith({
      spaceId: 'free-space',
      environmentId: 'master',
      entryId: 'other',
    });
    expect(sdk.cma.contentType.get).toHaveBeenCalledWith({
      spaceId: 'free-space',
      environmentId: 'master',
      contentTypeId: 'page',
    });
  });
});
