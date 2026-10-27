import {
  DEFAULT_LIMITS,
  defaultInstructionProfile,
  mockResponseMarkup,
  RICH_TEXT_VOCABULARY,
  type RichInline,
  type RichTextWork,
  readRichTextResult,
  readTranslationResponse,
  resolveTranslationSettings,
  serializeBlocks,
  type TranslateRequest,
} from '@ai-translator-for-contentful/protocol';
import type { ContentTypeField } from '@contentful/app-sdk';
import {
  BLOCKS,
  type Block,
  type Document,
  INLINES,
  type Inline,
  MARKS,
  type Paragraph,
  type Text,
  type TopLevelBlock,
} from '@contentful/rich-text-types';
import { describe, expect, it, vi } from 'vitest';
import { planTasks } from '../src/app/batch';
import { type Review, suggestionError, suggestionWarning } from '../src/app/dialog/model';
import { applyRichDraft } from '../src/app/draft';
import type { EditorSnapshot } from '../src/app/editor-snapshot';
import { planRun } from '../src/app/planner';
import { executeRun, startRun, taskResult } from '../src/app/run';
import { createContract, partSource, reconstruct } from '../src/richtext/contract';
import {
  rebuildRichText,
  richTextEditError,
  richTextFieldError,
  richTextPlanningError,
  richTextReviewValidation,
} from '../src/richtext/editor';
import { richTextReferenceError } from '../src/richtext/references';

type ContentTypeFieldValidation = NonNullable<ContentTypeField['validations']>[number];
// contentful-management's validation type omits the hyperlink node rules that Contentful sends.
type FieldValidation = ContentTypeFieldValidation & {
  nodes?: ContentTypeFieldValidation['nodes'] & { [INLINES.HYPERLINK]?: Pick<ContentTypeFieldValidation, 'size'>[] };
};
const text = (value: string, marks: string[] = []): Text => ({
  nodeType: 'text',
  value,
  marks: marks.map(type => ({ type })),
  data: {},
});
const paragraph = (...content: Array<Inline | Text>): Paragraph => ({ nodeType: BLOCKS.PARAGRAPH, data: {}, content });
const doc = (...content: TopLevelBlock[]): Document => ({ nodeType: BLOCKS.DOCUMENT, data: {}, content });
const field = (validations: FieldValidation[] = []): ContentTypeField => ({
  id: 'body',
  name: 'Body',
  type: 'RichText',
  localized: true,
  required: false,
  validations,
});
const isText = (node: Block | Inline | Text): node is Text => node.nodeType === 'text';
function nodeAt(document: Document, index: number): Block | Inline | Text {
  const node = document.content[0]?.content[index];
  if (!node) throw new Error(`No node at ${index}`);
  return node;
}
function textAt(document: Document, index: number): Text {
  const node = nodeAt(document, index);
  if (!isText(node)) throw new Error(`Node ${index} is not text`);
  return node;
}
const source = doc(
  paragraph(
    text('Open {name} '),
    text('carefully', [MARKS.BOLD]),
    text(' and '),
    { nodeType: INLINES.HYPERLINK, data: { uri: 'https://example.test/' }, content: [text('read this')] },
    text('\nNext  line '),
    text('const id = 1', [MARKS.CODE]),
  ),
);
const sourceContract = createContract(source);
const parser = { nodes: DEFAULT_LIMITS.parserNodes, depth: DEFAULT_LIMITS.parserDepth };
// The canonical model-facing markup of a whole document.
const markupOf = (document: Document) => serializeBlocks(partSource(createContract(document)), RICH_TEXT_VOCABULARY);
const workOf = (document: Document): RichTextWork => ({
  id: 'f-body',
  fieldId: 'body',
  name: 'Body',
  type: 'richText',
  source: partSource(createContract(document)),
});
// Reads translated markup with the same rules as a model response.
const unitsOf = (document: Document, markup: string): Map<string, RichInline[]> =>
  readRichTextResult(markup, workOf(document), parser);
const rebuild = (document: Document, markup: string) => rebuildRichText(document, unitsOf(document, markup));
const fragment = markupOf(source);

const snapshotOf = (document: Document) =>
  ({
    entryId: 'entry',
    contentTypeId: 'page',
    defaultLocale: 'en',
    locales: ['en', 'fi'],
    fields: { body: { en: document, fi: null } },
    definitions: [field()],
    controls: [{ fieldId: 'body', widgetNamespace: 'builtin', widgetId: 'richTextEditor' }],
  }) as unknown as EditorSnapshot;
const planOptions = (settings = {}) => ({
  settings: resolveTranslationSettings(settings, 20_000),
  limits: {
    requestBytes: DEFAULT_LIMITS.requestBytes,
    providerBodyBytes: DEFAULT_LIMITS.providerBodyBytes,
    resultBytes: DEFAULT_LIMITS.resultBytes,
  },
  model: 'model',
  profile: defaultInstructionProfile(),
  runGuidance: '',
  variableValues: {},
  availableLocales: ['en', 'fi'],
  explicitContext: [],
  envelope: (request: TranslateRequest) => request,
  id: () => crypto.randomUUID(),
});

async function generate(document: Document, change: (markup: string) => string, settings = {}) {
  const tasks = planTasks(snapshotOf(document), ['body'], 'en', ['fi']);
  const plan = planRun(tasks, planOptions(settings));
  let state = startRun(plan);
  await executeRun(
    () => state,
    next => {
      state = next;
    },
    async request => ({
      contract: 1,
      requestId: request.requestId,
      provider: 'openai-compatible',
      profileRevision: request.profileRevision,
      results: readTranslationResponse(change(mockResponseMarkup(request)), request, parser),
    }),
    new AbortController().signal,
    () => true,
  );
  return { result: taskResult(state, tasks[0], new Map()), state, plan };
}

describe('Rich Text editor integration', () => {
  it('shows a dropped bold span as a suggestion and requires exact-value warning approval before draft Apply', async () => {
    const document = doc(paragraph(text('Visit the '), text('blue house', [MARKS.BOLD]), text('.')));
    const { result, state } = await generate(document, markup =>
      markup.replace('<strong data-mark="m0">blue house</strong>', 'sinistä taloa'),
    );
    expect(state.parts[0].outcome).toMatchObject({ status: 'ok', result: { status: 'ok', type: 'richText' } });
    expect(result).toMatchObject({ status: 'ready' });
    expect(JSON.stringify(result?.suggestion)).toContain('sinistä taloa');
    const review = { ...result, choice: 'suggestion', originalSuggestion: result?.suggestion } as Review;
    expect(suggestionWarning(review)).toBe('Text formatting changed');
    expect(suggestionError(review)).toBe('Text formatting changed');
    review.approvedJson = JSON.stringify(review.suggestion);
    expect(suggestionError(review)).toBeUndefined();
    const port = {
      read: (locale: string) => (locale === 'en' ? document : null),
      isDisabled: () => false,
      dependenciesCurrent: () => true,
      write: vi.fn(async () => undefined),
    };
    const selection = {
      sourceLocale: 'en',
      targetLocale: 'fi',
      sourceSnapshot: document,
      targetSnapshot: null,
      suggestion: result?.suggestion as Document,
      definition: field(),
      choice: 'suggestion' as const,
    };
    expect(await applyRichDraft(port, selection, async () => true)).toMatchObject({
      status: 'invalid',
      detail: 'Text formatting changed',
    });
    expect(port.write).not.toHaveBeenCalled();
    expect(await applyRichDraft(port, { ...selection, warningApproved: true }, async () => true)).toMatchObject({
      status: 'applied',
    });
    expect(port.write).toHaveBeenCalledExactlyOnceWith(selection.suggestion, 'fi');
    review.suggestion = doc(paragraph(text('Edited again.')));
    expect(suggestionError(review)).toBe('Text formatting changed');
  });

  it('returns changed blocks and repeated known links for frontend warnings', async () => {
    const document = doc(...source.content, paragraph(text('Last paragraph.')));
    const { result } = await generate(document, markup =>
      markup.replace('<p id="u1">Last paragraph.</p>', '').replace('</p>', '<a data-link="l0">again</a></p>'),
    );
    expect(result).toMatchObject({ status: 'ready' });
    const validation = richTextReviewValidation(document, result?.suggestion, field());
    expect(validation.error).toBeUndefined();
    expect(validation.warning).toContain('Block structure changed');
    expect(validation.warning).toContain('A link changed');
    expect(JSON.stringify(result?.suggestion).match(/https:\/\/example.test\//g)).toHaveLength(2);
  });

  it('warns when one of two bold phrases loses its formatting, and permits a split emphasis span', async () => {
    const document = doc(paragraph(text('One', [MARKS.BOLD]), text(' and '), text('two', [MARKS.BOLD])));
    const { result } = await generate(document, markup =>
      markup.replace('<strong data-mark="m1">two</strong>', 'kaksi'),
    );
    expect(richTextReviewValidation(document, result?.suggestion, field()).warning).toContain(
      'Text formatting changed',
    );
    const split = doc(
      paragraph(
        text('One', [MARKS.BOLD]),
        text(' and '),
        text('two', [MARKS.BOLD]),
        text(' plus '),
        text('three', [MARKS.BOLD]),
      ),
    );
    expect(richTextReviewValidation(document, split, field())).toEqual({});
  });

  it('does not guess which embedded target survived when one of several embeds is omitted', async () => {
    const embed = (id: string) =>
      ({
        nodeType: BLOCKS.EMBEDDED_ENTRY,
        data: { target: { sys: { id, type: 'Link', linkType: 'Entry' } } },
        content: [],
      }) as TopLevelBlock;
    const document = doc(paragraph(text('Introduction.')), embed('first'), embed('second'));
    const { result } = await generate(document, markup => markup.replace('<embed data-kind="entry"/>', ''));
    expect(result).toMatchObject({
      status: 'error',
      rawSuggestion: expect.stringContaining('<embed data-kind="entry"/>'),
    });
  });

  it('joins reopened split-list containers when a changed part has an extra paragraph', async () => {
    const document = doc({
      nodeType: BLOCKS.UL_LIST,
      data: {},
      content: Array.from({ length: 4 }, (_, index) => ({
        nodeType: BLOCKS.LIST_ITEM,
        data: {},
        content: [paragraph(text(`List item ${index}: a long sentence about the blue house.`))],
      })),
    } as TopLevelBlock);
    const { result, plan } = await generate(
      document,
      markup =>
        markup.includes('id="u0"') ? markup.replace('</p>', '</p><p id="extra">An extra paragraph.</p>') : markup,
      { requestSourceCharacters: 60 },
    );
    expect(plan.requests.length).toBeGreaterThan(1);
    expect(result).toMatchObject({ status: 'ready' });
    const suggestion = result?.suggestion as Document;
    expect(suggestion.content).toHaveLength(1);
    expect(suggestion.content[0].content).toHaveLength(4);
    expect((suggestion.content[0].content[0] as Block).content).toHaveLength(2);
    expect(richTextReviewValidation(document, suggestion, field()).warning).toContain('Block structure changed');
  });

  it('retains format-valid content for inspection when an unknown link cannot be reconstructed', async () => {
    const { result } = await generate(source, markup => markup.replace('data-link="l0"', 'data-link="unknown"'));
    expect(result).toMatchObject({
      status: 'error',
      code: 'invalid_structure',
      rawSuggestion: expect.stringContaining('data-link="unknown"'),
    });
    expect(result?.suggestion).toBeUndefined();
  });

  it.each([false, true])(
    'shows changed placeholder and code text for warning review, changed blocks: %s',
    async changedBlocks => {
      const { result } = await generate(source, markup => {
        const changed = markup
          .replace('>{name}</span>', '>{nimi}</span>')
          .replace('>const id = 1</span>', '>const id = 2</span>');
        return changedBlocks ? changed.replace('<p id="u0">', '<h2 id="u0">').replace('</p>', '</h2>') : changed;
      });
      expect(result).toMatchObject({ status: 'ready' });
      expect(JSON.stringify(result?.suggestion)).toContain('{nimi}');
      expect(JSON.stringify(result?.suggestion)).toContain('const id = 2');
      const review = { ...result, choice: 'suggestion', originalSuggestion: result?.suggestion } as Review;
      expect(suggestionWarning(review)).toContain('Code text changed');
      expect(suggestionWarning(review)).toContain('placeholders');
      expect(suggestionError(review)).toBeDefined();
      review.approvedJson = JSON.stringify(review.suggestion);
      expect(suggestionError(review)).toBeUndefined();
    },
  );
  it('locks placeholders and code, while allowing a moved or split mark and preserving the link target', () => {
    expect(fragment).toContain('<span data-placeholder="p0">{name}</span>');
    expect(fragment).toContain('<span data-fixed="f0">const id = 1</span>');
    const translated = fragment
      .replace('Open ', 'Avaa ')
      .replace('carefully', 'huolellisesti')
      .replace(' and ', ' sekä ')
      .replace('read this', 'lue tämä')
      .replace('Next  line ', 'Seuraava  rivi ');
    const result = rebuild(source, translated);
    expect(JSON.stringify(result)).toContain('huolellisesti');
    expect(JSON.stringify(result)).toContain('https://example.test/');
    expect(JSON.stringify(result)).toContain('const id = 1');
    const split = `<p id="u0"><strong data-mark="m0">Avaa</strong> <span data-placeholder="p0"/> huolellisesti <a data-link="l0">lue tämä</a><br data-break="b0"/><strong data-mark="m0">Seuraava</strong> rivi <code data-mark="m1"><span data-fixed="f0"/></code></p>`;
    expect(() => reconstruct(sourceContract, unitsOf(source, split))).not.toThrow();
  });

  it('restores locked placeholder and code text even when the model changes it', () => {
    const changed = fragment
      .replace('>{name}</span>', '>{nimi}</span>')
      .replace('>const id = 1</span>', '>vakio id = 1</span>');
    const result = reconstruct(sourceContract, unitsOf(source, changed));
    expect(textAt(result, 0).value).toBe('Open {name} ');
    expect(JSON.stringify(result)).toContain('const id = 1');
    expect(JSON.stringify(result)).not.toContain('nimi');
  });

  it.each([
    ['missing placeholder', (value: string) => value.replace('<span data-placeholder="p0">{name}</span>', '')],
    ['duplicate placeholder', (value: string) => value.replace('</p>', '<span data-placeholder="p0"/></p>')],
    ['missing fixed code', (value: string) => value.replace('<span data-fixed="f0">const id = 1</span>', 'modified')],
    ['missing link', (value: string) => value.replace(/<a data-link="l0">.*?<\/a>/, 'plain')],
    ['malformed XML', (value: string) => value.replace('</p>', '')],
  ])('fails closed for %s', (_name, mutate) => {
    expect(() => rebuild(source, mutate(fragment))).toThrow();
  });

  it('keeps a structurally valid changed placeholder for explicit review', () => {
    const changed = fragment.replace(
      '<span data-placeholder="p0">{name}</span>',
      '{other}<span data-placeholder="p0">{name}</span>',
    );
    const result = rebuild(source, changed);
    expect(richTextReviewValidation(source, result, field())).toEqual({
      warning: 'Suggested text changed placeholders',
    });
  });

  it('lists each type of protected change in the warning', () => {
    const edited = structuredClone(source);
    textAt(edited, 0).value = 'Open {other} ';
    nodeAt(edited, 3).data.uri = 'https://other.test/';
    textAt(edited, 4).value = '\nNext  line\n';
    expect(richTextReviewValidation(source, edited, field()).warning).toBe(
      'A link changed; A line break changed; Suggested text changed placeholders',
    );
  });

  it('checks field marks, nodes, text size, and linked-node counts', () => {
    expect(richTextFieldError(doc(paragraph(text('Plain'))), field([{ enabledNodeTypes: [] }]))).toBeUndefined();
    expect(richTextFieldError(source, field([{ enabledMarks: [MARKS.ITALIC] }]))).toContain('mark disabled');
    expect(richTextFieldError(source, field([{ enabledNodeTypes: [BLOCKS.HEADING_1] }]))).toContain('disabled');
    expect(richTextFieldError(source, field([{ size: { max: 5 } }]))).toContain('size rule');
    expect(richTextFieldError(source, field([{ nodes: { [INLINES.HYPERLINK]: [{ size: { max: 0 } }] } }]))).toContain(
      'count',
    );
  });

  it('accepts native Rich Text edits while protecting source links, embeds, placeholders, and code', () => {
    const edited = structuredClone(source);
    textAt(edited, 0).value = 'Avaa {name} ';
    expect(richTextEditError(source, edited, field())).toBeUndefined();
    const missingPlaceholder = structuredClone(edited);
    textAt(missingPlaceholder, 0).value = 'Avaa ';
    expect(richTextEditError(source, missingPlaceholder, field())).toContain('placeholders');
    const changedLink = structuredClone(edited);
    nodeAt(changedLink, 3).data.uri = 'https://other.test/';
    expect(richTextEditError(source, changedLink, field())).toContain('link');
    const changedCode = structuredClone(edited);
    textAt(changedCode, 5).value = 'const id = 2';
    expect(richTextEditError(source, changedCode, field())).toContain('Code text');
    expect(richTextEditError(source, { nodeType: BLOCKS.DOCUMENT }, field())).toContain('invalid structure');
  });

  it('accepts a generated document when adjacent locked code runs are merged', () => {
    const splitCode = doc(
      paragraph(text('Before '), text('const ', [MARKS.CODE]), text('id = 1', [MARKS.CODE]), text(' after')),
    );
    const generated = rebuild(splitCode, markupOf(splitCode));
    expect(richTextEditError(splitCode, generated, field())).toBeUndefined();
  });

  it('does not mistake neighboring table-cell text for identifiers', () => {
    const table = (first: string, second: string) =>
      doc({
        nodeType: BLOCKS.TABLE,
        data: {},
        content: [
          {
            nodeType: BLOCKS.TABLE_ROW,
            data: {},
            content: [
              { nodeType: BLOCKS.TABLE_CELL, data: {}, content: [paragraph(text(first))] },
              { nodeType: BLOCKS.TABLE_CELL, data: {}, content: [paragraph(text(second))] },
            ],
          },
        ],
      });
    const original = table('Column 1 title', 'Column 2 title');
    const translated = table('Sarakkeen 1 otsikko', 'Sarakkeen 2 otsikko');
    expect(richTextEditError(original, translated, field())).toBeUndefined();
    const response = markupOf(original)
      .replace('Column 1 title', 'Sarakkeen 1 otsikko')
      .replace('Column 2 title', 'Sarakkeen 2 otsikko');
    expect(rebuild(original, response)).toEqual(translated);
    const identifier = table('Use order_id', 'Column 2 title');
    expect(richTextEditError(identifier, translated, field())).toContain('identifiers');
    const syntheticValue = table('veryLongNonBreakingValueThatMakesTheTableSuperLong', 'Column 2 title');
    const translatedValue = table('pitkäEiRivityksellinenArvoJokaTekeeTaulukostaErittäinPitkän', 'Column 2 title');
    expect(richTextReviewValidation(syntheticValue, translatedValue, field())).toEqual({
      warning: 'Suggested text changed identifiers',
    });
  });

  it('writes the final reviewed document directly and blocks invalid native edits', async () => {
    const values = { en: source as unknown, fi: null as unknown };
    const port = {
      read: (locale: string) => values[locale as 'en' | 'fi'],
      isDisabled: () => false,
      dependenciesCurrent: () => true,
      write: vi.fn(async () => undefined),
    };
    const edited = structuredClone(source);
    textAt(edited, 0).value = 'Avaa {name} ';
    const selection = {
      sourceLocale: 'en',
      targetLocale: 'fi',
      sourceSnapshot: source,
      targetSnapshot: null,
      suggestion: edited,
      definition: field(),
      choice: 'suggestion' as const,
    };
    expect((await applyRichDraft(port, selection, async () => true)).status).toBe('applied');
    expect(port.write).toHaveBeenCalledExactlyOnceWith(edited, 'fi');
    port.write.mockClear();
    const broken = structuredClone(edited);
    broken.content[0].content.splice(3, 1);
    expect((await applyRichDraft(port, { ...selection, suggestion: broken }, async () => true)).status).toBe('invalid');
    expect(port.write).not.toHaveBeenCalled();
  });

  it('requires approval for a valid warning while always blocking invalid structure', async () => {
    const original = doc(paragraph(text('Use order_id')));
    const suggested = doc(paragraph(text('Käytä tilaus_id')));
    const values = { en: original as unknown, fi: null as unknown };
    const port = {
      read: (locale: string) => values[locale as 'en' | 'fi'],
      isDisabled: () => false,
      dependenciesCurrent: () => true,
      write: vi.fn(async () => undefined),
    };
    const selection = {
      sourceLocale: 'en',
      targetLocale: 'fi',
      sourceSnapshot: original,
      targetSnapshot: null,
      suggestion: suggested,
      definition: field(),
      choice: 'suggestion' as const,
    };
    expect((await applyRichDraft(port, selection, async () => true)).status).toBe('invalid');
    expect(port.write).not.toHaveBeenCalled();
    expect((await applyRichDraft(port, { ...selection, warningApproved: true }, async () => true)).status).toBe(
      'applied',
    );
    expect(port.write).toHaveBeenCalledExactlyOnceWith(suggested, 'fi');
    port.write.mockClear();
    // Deliberately malformed: a text node cannot be a top-level block.
    const invalid = { nodeType: BLOCKS.DOCUMENT, data: {}, content: [text('invalid child')] } as unknown as Document;
    expect(
      (await applyRichDraft(port, { ...selection, suggestion: invalid, warningApproved: true }, async () => true))
        .status,
    ).toBe('invalid');
    expect(port.write).not.toHaveBeenCalled();
  });

  it('plans a Rich Text document that needs more than 20 whole-unit requests', () => {
    const large = doc(
      ...Array.from({ length: 21 }, (_, index) => paragraph(text(`Part ${index}. ${'word '.repeat(1500)}`))),
    );
    expect(richTextPlanningError(large)).toBeUndefined();
    const tasks = planTasks(snapshotOf(large), ['body'], 'en', ['fi']);
    expect(planRun(tasks, planOptions({ requestSourceCharacters: 7_600 })).requests).toHaveLength(21);
  });

  it('keeps output guidance short for a field of many short table cells', () => {
    const cell = (index: number) => ({
      nodeType: BLOCKS.TABLE_CELL,
      data: {},
      content: [paragraph(text(`c${index}`))],
    });
    const table = doc({
      nodeType: BLOCKS.TABLE,
      data: {},
      content: Array.from({ length: 150 }, (_, row) => ({
        nodeType: BLOCKS.TABLE_ROW,
        data: {},
        content: [cell(row * 2), cell(row * 2 + 1)],
      })),
    } as TopLevelBlock);
    const [request] = planRun(planTasks(snapshotOf(table), ['body'], 'en', ['fi']), planOptions()).requests;
    expect(request.request.fields).toHaveLength(1);
    expect(request.request.fields[0].outputGuidance?.length).toBeLessThan(200);
  });

  it('keeps a fitting document whole, sends the previewed request, and only returns a complete document', async () => {
    const long = doc(...Array.from({ length: 21 }, (_, index) => paragraph(text(`Sentence ${index}.`))));
    const tasks = planTasks(snapshotOf(long), ['body'], 'en', ['fi']);
    expect(tasks).toHaveLength(1);
    const plan = planRun(tasks, planOptions());
    expect(plan.requests).toHaveLength(1);
    const run = async (answer: (request: TranslateRequest) => string) => {
      let state = startRun(plan);
      const sent: string[] = [];
      await executeRun(
        () => state,
        next => {
          state = next;
        },
        async request => {
          sent.push(JSON.stringify(request));
          return {
            contract: 1,
            requestId: request.requestId,
            provider: 'openai-compatible',
            profileRevision: request.profileRevision,
            results: readTranslationResponse(answer(request), request, parser),
          };
        },
        new AbortController().signal,
        () => true,
      );
      expect(sent).toEqual([JSON.stringify(plan.requests[0].request)]);
      return taskResult(state, tasks[0], new Map());
    };
    const result = await run(request => mockResponseMarkup(request));
    expect(result?.status).toBe('ready');
    expect(result?.suggestion).toEqual(long);
    const changed = await run(request => mockResponseMarkup(request).replace('<p id="u20">Sentence 20.</p>', ''));
    expect(changed).toMatchObject({ status: 'ready' });
    expect(richTextReviewValidation(long, changed?.suggestion, field()).warning).toContain('Block structure changed');
  });

  it('rechecks source and target, validates fragments, and writes one draft document', async () => {
    const values = { en: source as unknown, fi: null as unknown };
    const port = {
      read: (locale: string) => values[locale as 'en' | 'fi'],
      isDisabled: () => false,
      dependenciesCurrent: () => true,
      write: vi.fn(async () => undefined),
    };
    const selection = {
      sourceLocale: 'en',
      targetLocale: 'fi',
      sourceSnapshot: source,
      targetSnapshot: null,
      suggestion: rebuild(source, fragment),
      definition: field(),
      choice: 'suggestion' as const,
    };
    expect((await applyRichDraft(port, selection, async () => true)).status).toBe('applied');
    expect(port.write).toHaveBeenCalledExactlyOnceWith(source, 'fi');
    port.write.mockClear();
    values.en = doc(paragraph(text('changed')));
    expect((await applyRichDraft(port, selection, async () => true)).status).toBe('conflict');
    expect(port.write).not.toHaveBeenCalled();
    values.en = source;
    const broken = { ...selection, suggestion: { nodeType: BLOCKS.DOCUMENT, data: {}, content: [] } as Document };
    expect((await applyRichDraft(port, broken, async () => true)).status).toBe('invalid');
    expect(port.write).not.toHaveBeenCalled();
  });

  it('checks a restricted entry reference before writing a reconstructed draft', async () => {
    const referenced = doc(
      paragraph(text('Read '), {
        nodeType: INLINES.EMBEDDED_ENTRY,
        data: { target: { sys: { id: 'entry-1', type: 'Link', linkType: 'Entry' } } },
        content: [],
      }),
    );
    const restricted = field([{ nodes: { [INLINES.EMBEDDED_ENTRY]: [{ linkContentType: ['allowed'] }] } }]);
    const values = { en: referenced as unknown, fi: null as unknown };
    const port = {
      read: (locale: string) => values[locale as 'en' | 'fi'],
      isDisabled: () => false,
      dependenciesCurrent: () => true,
      write: vi.fn(async () => undefined),
    };
    const selection = {
      sourceLocale: 'en',
      targetLocale: 'fi',
      sourceSnapshot: referenced,
      targetSnapshot: null,
      suggestion: rebuild(referenced, markupOf(referenced)),
      definition: restricted,
      choice: 'suggestion' as const,
    };
    const lookup = { spaceId: 'space', environmentId: 'master', entryContentType: vi.fn(async () => 'other') };
    expect(await applyRichDraft(port, selection, async () => true, lookup)).toMatchObject({
      status: 'invalid',
      detail: expect.stringContaining('content type rule'),
    });
    expect(port.write).not.toHaveBeenCalled();
    lookup.entryContentType.mockResolvedValue('allowed');
    expect((await applyRichDraft(port, selection, async () => true, lookup)).status).toBe('applied');
    expect(port.write).toHaveBeenCalledOnce();
    expect(lookup.entryContentType).toHaveBeenCalledWith({
      spaceId: 'space',
      environmentId: 'master',
      entryId: 'entry-1',
    });
    port.write.mockClear();
    lookup.entryContentType.mockImplementation(async () => {
      values.fi = doc(paragraph(text('newer draft')));
      return 'allowed';
    });
    expect((await applyRichDraft(port, selection, async () => true, lookup)).status).toBe('conflict');
    expect(port.write).not.toHaveBeenCalled();
  });

  it('validates a cross-space resource against its configured source and content type', async () => {
    const resource: TopLevelBlock = {
      nodeType: BLOCKS.EMBEDDED_RESOURCE,
      data: {
        target: {
          sys: {
            type: 'ResourceLink',
            linkType: 'Contentful:Entry',
            urn: 'crn:contentful:::content:spaces/other/environments/stage/entries/entry-2',
          },
        },
      },
      content: [],
    };
    const referenced = doc(paragraph(text('A sentence.')), resource);
    const allowedResources = [
      {
        type: 'Contentful:Entry',
        source: 'crn:contentful:::content:spaces/other/environments/stage',
        contentTypes: ['allowed'],
      },
    ];
    const restricted = field([{ nodes: { [BLOCKS.EMBEDDED_RESOURCE]: { validations: [], allowedResources } } }]);
    const lookup = { spaceId: 'space', environmentId: 'master', entryContentType: vi.fn(async () => 'allowed') };
    expect(await richTextReferenceError(referenced, restricted, lookup)).toBeUndefined();
    expect(lookup.entryContentType).toHaveBeenCalledWith({
      spaceId: 'other',
      environmentId: 'stage',
      entryId: 'entry-2',
    });
    lookup.entryContentType.mockResolvedValue('other');
    expect(await richTextReferenceError(referenced, restricted, lookup)).toContain(
      'allowed resource content type rule',
    );
    expect(await richTextReferenceError(referenced, restricted)).toContain('cannot be checked');
  });
});
