import type { ContentTypeField, DialogAppSDK } from '@contentful/app-sdk';
import { BLOCKS, type Document, INLINES } from '@contentful/rich-text-types';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '../src/app/batch';
import { CHOICE_UNAVAILABLE } from '../src/app/choices';
import { expandableType } from '../src/app/dialog/ExpandView';
import {
  applySummary,
  canShowRequestDetails,
  chooseSuggestionsInTab,
  fieldPreview,
  fieldTypeLabel,
  hasContent,
  plainError,
  type Review,
  restoreGeneratedSuggestion,
  reviewFromResult,
  selectableFields,
  suggestionWarning,
  unappliedOutcome,
  usableReview,
  validationCopy,
} from '../src/app/dialog/model';
import { ReviewScreen } from '../src/app/dialog/ReviewScreen';
import { DialogRichTextPreview, richTextWordCount } from '../src/app/dialog/RichTextView';
import type { EditorSnapshot } from '../src/app/editor-snapshot';

const field = (id: string, type: ContentTypeField['type'], name = id) =>
  ({ id, name, type, localized: true, required: false, validations: [] }) as ContentTypeField;
const snapshot: EditorSnapshot = {
  entryId: 'entry',
  contentTypeId: 'page',
  defaultLocale: 'en',
  locales: ['en', 'fi', 'sv'],
  fields: {
    title: { en: 'Red house', fi: '' },
    body: { en: 'Long text' },
    tags: { en: ['red', 'small'] },
    hidden: { en: '' },
  },
  definitions: [
    field('title', 'Symbol'),
    field('body', 'Text'),
    { ...field('tags', 'Array'), items: { type: 'Symbol', validations: [] } } as ContentTypeField,
    field('hidden', 'Symbol'),
  ],
  controls: [{ fieldId: 'tags', widgetId: 'tagEditor', widgetNamespace: 'builtin' }],
};
const task = (fieldId: string, targetLocale: string): Task => ({
  key: `${fieldId}:${targetLocale}`,
  entryId: snapshot.entryId,
  fieldId,
  fieldName: fieldId,
  kind: 'text',
  longText: fieldId === 'body',
  order: 0,
  definition: snapshot.definitions.find(definition => definition.id === fieldId) ?? field(fieldId, 'Symbol'),
  sourceLocale: 'en',
  targetLocale,
  sourceSnapshot: snapshot.fields[fieldId]?.en as string,
  targetSnapshot: snapshot.fields[fieldId]?.[targetLocale] ?? null,
  size: { max: 100 },
});
const ready = (value: Task, choice: Review['choice'] = 'keep'): Review => ({
  task: value,
  status: 'ready',
  suggestion: 'Translated',
  provider: 'openai-compatible',
  choice,
});
const provider = (value: Review['provider']) => value === 'openai-compatible';
const reviewScreenProps = (value: Task, review: Review, current: EditorSnapshot) => ({
  sdk: {} as DialogAppSDK,
  tasks: [value],
  reviews: { [value.key]: review },
  snapshot: current,
  localeNames: { en: 'English', fi: 'Finnish' },
  targets: ['fi'],
  activeTab: 'fi',
  onTab: () => {},
  sourceOpen: true,
  onSourceOpen: () => {},
  nowOpen: {},
  onNowOpen: () => {},
  generating: false,
  run: { requests: [], parts: [] },
  onStop: () => {},
  onUseAll: () => {},
  onChoice: () => {},
  onSuggestion: () => {},
  onRetry: () => {},
  canRetrySmaller: () => false,
  onStartRetry: () => {},
  onCancelRetry: () => {},
  onExpand: () => {},
  onRestore: () => {},
  onApproveWarning: () => {},
  usableProvider: provider,
});

describe('translate dialog presentation logic', () => {
  it('uses plain language for service and stale errors', () => {
    expect(plainError('Relay 401: invalid_signature')).toContain('could not verify this app');
    expect(plainError('Editor values changed during generation')).toContain('Translate again');
    expect(plainError('Relay 429: concurrency_limit')).toBe(
      'Another translation for this entry is still running. Retry this field when it finishes.',
    );
    expect(plainError('unrecognized_code')).not.toContain('unrecognized_code');
    expect(plainError(`Array item 2: ${CHOICE_UNAVAILABLE}`)).toBe(CHOICE_UNAVAILABLE);
    expect(plainError('Relay 400: model_not_allowed')).toBe(CHOICE_UNAVAILABLE);
  });

  it('shows exact request details only for explicit debug mode', () => {
    expect(canShowRequestDetails(undefined)).toBe(false);
    expect(canShowRequestDetails(false)).toBe(false);
    expect(canShowRequestDetails('true')).toBe(false);
    expect(canShowRequestDetails(true)).toBe(true);
  });

  it('labels and previews supported fields while hiding empty source fields', () => {
    expect(selectableFields(snapshot, 'en').map(value => value.id)).toEqual(['title', 'body', 'tags']);
    expect(fieldTypeLabel(snapshot.definitions[0], 'Red house')).toBe('Short text');
    expect(fieldTypeLabel(snapshot.definitions[1], 'Long text')).toBe('Long text');
    expect(fieldTypeLabel(snapshot.definitions[1], '**Markdown**', 'markdown')).toBe('Markdown');
    expect(fieldTypeLabel(snapshot.definitions[1], 'One line', 'singleLine')).toBe('Short text');
    expect(fieldTypeLabel(snapshot.definitions[2], ['red', 'small'])).toBe('List of 2');
    expect(fieldPreview(['red', 'small'])).toBe('red, small');
    expect(
      fieldPreview({
        nodeType: 'document',
        content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'A rich sentence.' }] }],
      }),
    ).toBe('A rich sentence.');
  });

  it('opens the editor configured for each expandable text field', () => {
    const body = task('body', 'fi');
    expect(expandableType(body, 'markdown')).toBe('Markdown');
    expect(expandableType(body, 'multipleLine')).toBe('Long text');
    expect(expandableType(body, undefined)).toBe('Long text');
    expect(expandableType(body, 'singleLine')).toBeUndefined();
  });

  it('counts only current, valid Use decisions for the draft summary', () => {
    const title = task('title', 'fi');
    const body = task('body', 'fi');
    const reviews = { [title.key]: ready(title, 'suggestion'), [body.key]: ready(body, 'keep') };
    expect(applySummary([title, body], reviews, snapshot, provider).count).toBe(1);
    expect(
      applySummary(
        [title, body],
        reviews,
        { ...snapshot, fields: { ...snapshot.fields, title: { en: 'Changed', fi: '' } } },
        provider,
      ).count,
    ).toBe(0);
    expect(
      applySummary(
        [title, body],
        { ...reviews, [title.key]: { ...reviews[title.key], suggestion: 'x'.repeat(101) } },
        snapshot,
        provider,
      ).count,
    ).toBe(0);
  });

  it('offers Expand only for fields with an expanded editor', () => {
    const body = task('body', 'fi');
    const render = (widgetId: string) =>
      renderToStaticMarkup(
        React.createElement(
          ReviewScreen,
          reviewScreenProps(body, ready(body), {
            ...snapshot,
            controls: [{ fieldId: 'body', widgetId, widgetNamespace: 'builtin' }],
          }),
        ),
      );
    expect(render('multipleLine')).toContain('Expand');
    expect(render('markdown')).toContain('Expand');
    expect(render('urlEditor')).not.toContain('Expand');
    expect(render('singleLine')).not.toContain('Expand');
  });

  it('leaves stale failures out of Retry failed', () => {
    const title = task('title', 'fi');
    const failure = (code: string): Review => ({ task: title, status: 'error', code, detail: code, choice: 'keep' });
    const render = (review: Review) =>
      renderToStaticMarkup(React.createElement(ReviewScreen, reviewScreenProps(title, review, snapshot)));
    expect(render(failure('provider_timeout'))).toContain('Retry failed');
    expect(render(failure('stale'))).not.toContain('Retry failed');
  });

  it('reports a chosen suggestion that cannot be applied as a conflict or invalid, never kept', () => {
    const title = task('title', 'fi');
    const chosen = ready(title, 'suggestion');
    expect(unappliedOutcome(ready(title, 'keep'), snapshot)).toEqual({ status: 'kept' });
    expect(
      unappliedOutcome(chosen, { ...snapshot, fields: { ...snapshot.fields, title: { en: 'Changed', fi: '' } } }),
    ).toEqual({ status: 'conflict' });
    expect(unappliedOutcome({ ...chosen, suggestion: 'x'.repeat(101) }, snapshot)).toMatchObject({
      status: 'invalid',
      detail: expect.any(String),
    });
    expect(unappliedOutcome(undefined, snapshot)).toEqual({ status: 'not_generated' });
  });

  it('selects Use new for usable results and keeps invalid or stale results out of the draft', () => {
    const title = task('title', 'fi');
    const result = {
      task: title,
      status: 'ready' as const,
      suggestion: 'Translated',
      provider: 'openai-compatible' as const,
    };
    const review = reviewFromResult(result, snapshot, provider);
    expect(review.choice).toBe('suggestion');
    expect(applySummary([title], { [title.key]: review }, snapshot, provider).count).toBe(1);
    expect(reviewFromResult({ ...result, suggestion: 'x'.repeat(101) }, snapshot, provider).choice).toBe('keep');
    expect(
      reviewFromResult(
        result,
        { ...snapshot, fields: { ...snapshot.fields, title: { en: 'Changed', fi: '' } } },
        provider,
      ).choice,
    ).toBe('keep');
    expect(reviewFromResult({ ...result, provider: 'mock' }, snapshot, provider).choice).toBe('keep');
    expect(reviewFromResult({ task: title, status: 'error', detail: 'Failed' }, snapshot, provider).choice).toBe(
      'keep',
    );

    const document: Document = {
      nodeType: BLOCKS.DOCUMENT,
      data: {},
      content: [
        {
          nodeType: BLOCKS.PARAGRAPH,
          data: {},
          content: [{ nodeType: 'text', value: 'Long text', marks: [], data: {} }],
        },
      ],
    };
    const richSnapshot = { ...snapshot, fields: { ...snapshot.fields, body: { en: document, fi: null } } };
    const richTask: Task = {
      ...task('body', 'fi'),
      kind: 'richText',
      sourceSnapshot: document,
      targetSnapshot: null,
      definition: field('body', 'RichText'),
    };
    const richReview = reviewFromResult(
      {
        task: richTask,
        status: 'ready',
        suggestion: document,
        provider: 'openai-compatible',
      },
      richSnapshot,
      provider,
    );
    expect(richReview.choice).toBe('suggestion');
    expect(richReview.originalSuggestion).toEqual(document);
  });

  it('restoring a valid Rich Text suggestion makes it applicable again', () => {
    const document: Document = {
      nodeType: BLOCKS.DOCUMENT,
      data: {},
      content: [
        {
          nodeType: BLOCKS.PARAGRAPH,
          data: {},
          content: [{ nodeType: 'text', value: 'Long text', marks: [], data: {} }],
        },
      ],
    };
    const richSnapshot = { ...snapshot, fields: { ...snapshot.fields, body: { en: document, fi: null } } };
    const richTask: Task = {
      ...task('body', 'fi'),
      kind: 'richText',
      sourceSnapshot: document,
      targetSnapshot: null,
      definition: field('body', 'RichText'),
    };
    const original = reviewFromResult(
      { task: richTask, status: 'ready', suggestion: document, provider: 'openai-compatible' },
      richSnapshot,
      provider,
    );
    const changed: Review = {
      ...original,
      choice: 'keep',
      suggestion: { ...document, content: [] },
      detail: 'The Rich Text document has an invalid structure',
    };
    const restored = restoreGeneratedSuggestion(changed, richSnapshot, provider);
    expect(restored.suggestion).toEqual(document);
    expect(restored.suggestion).not.toBe(original.originalSuggestion);
    expect(restored.detail).toBeUndefined();
    expect(restored.editorRevision).toBe(1);
    expect(restored.choice).toBe('suggestion');
    expect(applySummary([richTask], { [richTask.key]: restored }, richSnapshot, provider).count).toBe(1);
    expect(restoreGeneratedSuggestion(changed, snapshot, provider).choice).toBe('keep');
  });

  it('requires approval for the exact Rich Text suggestion with a protected-text warning', () => {
    const source: Document = {
      nodeType: BLOCKS.DOCUMENT,
      data: {},
      content: [
        {
          nodeType: BLOCKS.PARAGRAPH,
          data: {},
          content: [{ nodeType: 'text', value: 'Use order_id', marks: [], data: {} }],
        },
      ],
    };
    const suggestion: Document = {
      ...source,
      content: [
        { ...source.content[0], content: [{ nodeType: 'text', value: 'Käytä tilaus_id', marks: [], data: {} }] },
      ],
    };
    const richSnapshot = { ...snapshot, fields: { ...snapshot.fields, body: { en: source, fi: null } } };
    const richTask: Task = {
      ...task('body', 'fi'),
      kind: 'richText',
      sourceSnapshot: source,
      targetSnapshot: null,
      definition: field('body', 'RichText'),
    };
    const review = reviewFromResult(
      { task: richTask, status: 'ready', suggestion, provider: 'openai-compatible' },
      richSnapshot,
      provider,
    );
    expect(suggestionWarning(review)).toBe('Suggested text changed identifiers');
    expect(review.choice).toBe('keep');
    expect(usableReview(review, richSnapshot, provider)).toBe(false);
    expect(validationCopy(review)).toContain('Review the change carefully');
    const screenProps = reviewScreenProps(richTask, review, richSnapshot);
    const html = renderToStaticMarkup(React.createElement(ReviewScreen, screenProps));
    expect(html).toContain('Approve this change');
    expect(html).toContain('Suggested text changed identifiers');
    const approved: Review = { ...review, choice: 'suggestion', approvedJson: JSON.stringify(suggestion) };
    expect(usableReview(approved, richSnapshot, provider)).toBe(true);
    expect(applySummary([richTask], { [richTask.key]: approved }, richSnapshot, provider).count).toBe(1);
    expect(validationCopy(approved)).toContain('Review the change carefully');
    expect(
      renderToStaticMarkup(
        React.createElement(ReviewScreen, { ...screenProps, reviews: { [richTask.key]: approved } }),
      ),
    ).toContain('Approved for this suggestion');
    const edited: Review = { ...approved, suggestion: source };
    expect(usableReview(edited, richSnapshot, provider)).toBe(true);
    const editedWarning: Review = {
      ...approved,
      suggestion: {
        ...suggestion,
        content: [
          { ...suggestion.content[0], content: [{ nodeType: 'text', value: 'Käytä toinen_id', marks: [], data: {} }] },
        ],
      },
    };
    expect(usableReview(editedWarning, richSnapshot, provider)).toBe(false);
    expect(restoreGeneratedSuggestion(approved, richSnapshot, provider).approvedJson).toBeUndefined();
  });

  it('lets the editor approve or restore an edited text suggestion with changed protected text', () => {
    const source = 'Use **order_id**';
    const textSnapshot = { ...snapshot, fields: { ...snapshot.fields, body: { en: source } } };
    const body: Task = { ...task('body', 'fi'), sourceSnapshot: source };
    const review = reviewFromResult(
      { task: body, status: 'ready', suggestion: 'Käytä **order_id**', provider: 'openai-compatible' },
      textSnapshot,
      provider,
    );
    expect(review.choice).toBe('suggestion');
    const edited: Review = { ...review, suggestion: 'Käytä **HUOM** order_id' };
    expect(suggestionWarning(edited)).toBe('Suggested text changed identifiers');
    expect(usableReview(edited, textSnapshot, provider)).toBe(false);
    expect(validationCopy(edited)).toContain('Review the change carefully before using this suggestion');
    const html = renderToStaticMarkup(React.createElement(ReviewScreen, reviewScreenProps(body, edited, textSnapshot)));
    expect(html).toContain('Approve this change');
    expect(html).toContain('Restore generated text');

    const approved: Review = { ...edited, choice: 'suggestion', approvedJson: JSON.stringify(edited.suggestion) };
    expect(usableReview(approved, textSnapshot, provider)).toBe(true);
    expect(applySummary([body], { [body.key]: approved }, textSnapshot, provider).count).toBe(1);
    expect(usableReview({ ...approved, suggestion: 'Käytä HUOM' }, textSnapshot, provider)).toBe(false);
    // Approval never overrides a field rule.
    const tooLong = 'x'.repeat(101);
    expect(
      usableReview({ ...approved, suggestion: tooLong, approvedJson: JSON.stringify(tooLong) }, textSnapshot, provider),
    ).toBe(false);

    const restored = restoreGeneratedSuggestion(approved, textSnapshot, provider);
    expect(restored.suggestion).toBe('Käytä **order_id**');
    expect(restored.approvedJson).toBeUndefined();
    expect(restored.editorRevision).toBe(1);
    expect(restored.choice).toBe('suggestion');
    expect(
      renderToStaticMarkup(React.createElement(ReviewScreen, reviewScreenProps(body, restored, textSnapshot))),
    ).not.toContain('Restore generated text');
  });

  it('shows relay debug details under a failed field', () => {
    const title = task('title', 'fi');
    const failed: Review = {
      task: title,
      status: 'error',
      code: 'invalid_provider_response',
      debug: 'reason: <field> is not allowed here.\nanswer:\n<field id="f-title">Hei</field>',
      choice: 'keep',
    };
    const html = renderToStaticMarkup(React.createElement(ReviewScreen, reviewScreenProps(title, failed, snapshot)));
    expect(html).toContain('The model’s answer could not be read.');
    expect(html).toContain('Debug details from the translation service');
    expect(html).toContain('&lt;field id=&quot;f-title&quot;&gt;Hei&lt;/field&gt;');
    const quiet = renderToStaticMarkup(
      React.createElement(ReviewScreen, reviewScreenProps(title, { ...failed, debug: undefined }, snapshot)),
    );
    expect(quiet).not.toContain('Debug details');
  });

  it('shows the source column and hides the current-value column until a field in the tab has a value', () => {
    const title = task('title', 'fi');
    const render = (current: EditorSnapshot, nowOpen: Record<string, boolean> = {}) =>
      renderToStaticMarkup(
        React.createElement(ReviewScreen, { ...reviewScreenProps(title, ready(title), current), nowOpen }),
      );
    const empty = render(snapshot);
    expect(empty).toContain('dialog-review-now-closed');
    expect(empty).toContain('aria-label="Show Finnish now"');
    expect(empty).toContain('aria-expanded="false"');
    const filled = { ...snapshot, fields: { ...snapshot.fields, title: { en: 'Red house', fi: 'Punainen talo' } } };
    expect(render(filled)).not.toContain('dialog-review-now-closed');
    expect(render(filled)).toContain('aria-label="Hide Finnish now"');
    expect(render(filled, { fi: false })).toContain('dialog-review-now-closed');
    expect(render(snapshot, { fi: true })).not.toContain('dialog-review-now-closed');
    expect(empty).toContain('aria-label="Hide English"');
    expect(empty).not.toContain('dialog-review-source-closed');
  });

  it('treats blank text, empty lists, and empty Rich Text as no content', () => {
    const doc = (...content: unknown[]) => ({ nodeType: BLOCKS.DOCUMENT, data: {}, content });
    const paragraph = (value: string) => ({
      nodeType: BLOCKS.PARAGRAPH,
      data: {},
      content: [{ nodeType: 'text', value, marks: [], data: {} }],
    });
    expect([null, undefined, '', '  ', []].map(hasContent)).toEqual([false, false, false, false, false]);
    expect(hasContent(doc(paragraph('')))).toBe(false);
    expect(hasContent(doc(paragraph('Hei')))).toBe(true);
    expect(hasContent(doc({ nodeType: BLOCKS.EMBEDDED_ENTRY, data: {}, content: [] }))).toBe(true);
    expect(hasContent(['punainen'])).toBe(true);
  });

  it('Use all changes only usable rows in the chosen language', () => {
    const fi = task('title', 'fi');
    const sv = task('title', 'sv');
    const invalid = task('body', 'fi');
    const reviews = {
      [fi.key]: ready(fi),
      [sv.key]: ready(sv),
      [invalid.key]: { ...ready(invalid), suggestion: 'x'.repeat(101) },
    };
    const result = chooseSuggestionsInTab([fi, sv, invalid], reviews, 'fi', snapshot, provider);
    expect(result[fi.key].choice).toBe('suggestion');
    expect(result[sv.key].choice).toBe('keep');
    expect(result[invalid.key].choice).toBe('keep');
  });

  it('keeps Rich Text links and embedded targets visually locked without exposing IDs', () => {
    const value = {
      nodeType: BLOCKS.DOCUMENT,
      data: {},
      content: [
        {
          nodeType: BLOCKS.PARAGRAPH,
          data: {},
          content: [
            { nodeType: 'text', value: 'Read ', marks: [], data: {} },
            {
              nodeType: INLINES.HYPERLINK,
              data: { uri: 'https://example.test/secret' },
              content: [{ nodeType: 'text', value: 'this link', marks: [], data: {} }],
            },
            {
              nodeType: INLINES.EMBEDDED_ENTRY,
              data: { target: { sys: { id: 'secret-entry', type: 'Link', linkType: 'Entry' } } },
              content: [],
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(React.createElement(DialogRichTextPreview, { value }));
    expect(html).toContain('this link');
    expect(html).toContain('Embedded entry');
    expect(html).not.toContain('secret-entry');
    expect(html).not.toContain('example.test');
    expect(richTextWordCount(value)).toBe(3);
    const invalid = {
      ...ready(task('body', 'fi')),
      task: { ...task('body', 'fi'), kind: 'richText' as const },
      detail: 'missing data-link l0',
    };
    expect(validationCopy(invalid)).toContain('Restore the generated text');
    expect(validationCopy({ ...invalid, detail: 'Missing or duplicate locked ID l0' })).toContain(
      'Restore the generated text',
    );
    expect(validationCopy({ ...invalid, detail: 'The Rich Text document has an invalid structure' })).toContain(
      'invalid structure',
    );
    expect(plainError('Code text changed. Restore the generated text to use it.')).toBe(
      'Code text changed. Retry this field.',
    );
  });

  it('renders Rich Text tables with header cells in a scrollable frame', () => {
    const cell = (nodeType: BLOCKS.TABLE_CELL | BLOCKS.TABLE_HEADER_CELL, value: string) => ({
      nodeType,
      data: {},
      content: [{ nodeType: BLOCKS.PARAGRAPH, data: {}, content: [{ nodeType: 'text', value, marks: [], data: {} }] }],
    });
    const value = {
      nodeType: BLOCKS.DOCUMENT,
      data: {},
      content: [
        {
          nodeType: BLOCKS.TABLE,
          data: {},
          content: [
            { nodeType: BLOCKS.TABLE_ROW, data: {}, content: [cell(BLOCKS.TABLE_HEADER_CELL, 'Day')] },
            { nodeType: BLOCKS.TABLE_ROW, data: {}, content: [cell(BLOCKS.TABLE_CELL, 'Monday')] },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(React.createElement(DialogRichTextPreview, { value }));
    expect(html).toContain(
      '<div class="dialog-rich-table"><table><tbody><tr><th><p>Day</p></th></tr><tr><td><p>Monday</p></td></tr></tbody></table></div>',
    );
  });
});
