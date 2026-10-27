import {
  DEFAULT_LIMITS,
  defaultInstructionProfile,
  mockResponseMarkup,
  type RichTextWork,
  readTranslationResponse,
  resolveTranslationSettings,
  type TranslateRequest,
  type TranslateResponse,
  type TranslationSettings,
} from '@ai-translator-for-contentful/protocol';
import { BLOCKS, type Document } from '@contentful/rich-text-types';
import { describe, expect, it, vi } from 'vitest';
import { type Dependency, planTasks, type Task, type TaskResult } from '../src/app/batch';
import { dependenciesCurrent, fieldSourceProblem, isCurrent, selectableFields } from '../src/app/dialog/model';
import { applyTextDraft } from '../src/app/draft';
import type { EditorSnapshot } from '../src/app/editor-snapshot';
import { fixedTokenError } from '../src/app/placeholders';
import { PlanError, type PlanOptions, planRetry, planRun, textSegments } from '../src/app/planner';
import {
  executeRun,
  failedGroups,
  keptRanges,
  type RunState,
  retryRun,
  smallerRetryApplies,
  startRun,
  taskResult,
} from '../src/app/run';
import { readyFieldCount } from '../src/app/sidebar-model';
import { RelayError } from '../src/app/signed';

const profile = defaultInstructionProfile();
const parser = { nodes: DEFAULT_LIMITS.parserNodes, depth: DEFAULT_LIMITS.parserDepth };

function paragraph(text: string, tag = BLOCKS.PARAGRAPH) {
  return { nodeType: tag, data: {}, content: [{ nodeType: 'text', value: text, marks: [], data: {} }] };
}
function document(...content: unknown[]): Document {
  return { nodeType: BLOCKS.DOCUMENT, data: {}, content } as Document;
}

const snapshot = {
  entryId: 'entry',
  contentTypeId: 'test',
  defaultLocale: 'en',
  locales: ['en', 'fi', 'sv'],
  fields: {
    headline: { en: 'Hello {name}', fi: null, sv: null },
    tags: { en: ['red, green', '  ', 'blue'], fi: null, sv: null },
    body: { en: 'First paragraph.\n\nSecond paragraph.', fi: null, sv: null },
    rich: { en: document(paragraph('Rich intro.')), fi: null, sv: null },
  },
  definitions: [
    { id: 'headline', name: 'Headline', type: 'Symbol', localized: true },
    { id: 'tags', name: 'Tags', type: 'Array', items: { type: 'Symbol' }, localized: true },
    { id: 'body', name: 'Body', type: 'Text', localized: true },
    { id: 'rich', name: 'Rich', type: 'RichText', localized: true },
  ],
  controls: [{ fieldId: 'tags', widgetNamespace: 'builtin', widgetId: 'listInput' }],
} as unknown as EditorSnapshot;

let id = 0;
function options(settings: TranslationSettings = {}, change: Partial<PlanOptions> = {}): PlanOptions {
  return {
    settings: resolveTranslationSettings(settings, 20_000),
    limits: {
      requestBytes: DEFAULT_LIMITS.requestBytes,
      providerBodyBytes: DEFAULT_LIMITS.providerBodyBytes,
      resultBytes: DEFAULT_LIMITS.resultBytes,
    },
    model: 'test-model',
    profile,
    runGuidance: '',
    variableValues: {},
    availableLocales: snapshot.locales,
    explicitContext: [],
    envelope: request => ({ provider: 'primary', request }),
    id: () => `request-${++id}`,
    ...change,
  };
}

// A provider stand-in: the protocol's mock answer, or a custom one per work.
function reply(request: TranslateRequest, markup = mockResponseMarkup(request)): TranslateResponse {
  return {
    contract: 1,
    requestId: request.requestId,
    provider: 'openai-compatible',
    profileRevision: request.profileRevision,
    results: readTranslationResponse(markup, request, parser),
  };
}
// An answer that returns every source unchanged.
function identity(request: TranslateRequest): string {
  const fields = request.fields.map(work => {
    if (work.type === 'text') return `<field id="${work.id}">${work.source.replaceAll('<', '&lt;')}</field>`;
    if (work.type === 'array')
      return `<field id="${work.id}">${work.items.map(item => `<item id="${item.id}">${item.text}</item>`).join('')}</field>`;
    return mockResponseMarkup({ ...request, fields: [work] }).replace(/^<translation>|<\/translation>$/g, '');
  });
  return `<translation>${fields.join('')}</translation>`;
}

async function runAll(
  state: RunState,
  send: (request: TranslateRequest) => Promise<TranslateResponse>,
  current: (dependencies: Dependency[]) => boolean = () => true,
) {
  let value = state;
  await executeRun(
    () => value,
    next => {
      value = next;
    },
    request => send(request),
    new AbortController().signal,
    current,
  );
  return value;
}

describe('grouped request planning', () => {
  it('identifies Markdown by the configured editor without protecting emphasized words as placeholders', () => {
    const source = 'Transient __editor__ source A';
    const markdown = {
      ...snapshot,
      fields: { ...snapshot.fields, body: { en: source, fi: null } },
      controls: [{ fieldId: 'body', widgetNamespace: 'builtin', widgetId: 'markdown' }],
    } as EditorSnapshot;
    const [planned] = planRun(planTasks(markdown, ['body'], 'en', ['fi']), options()).requests;
    const [work] = planned.request.fields;
    expect(work).toMatchObject({ type: 'text', source });
    expect(work.outputGuidance).toContain('The source is Markdown-formatted text.');
    expect(work.outputGuidance).not.toContain('Preserve these identifiers');
    expect(work.outputGuidance).not.toContain('Preserve these placeholder occurrences');
    expect(planned.messages[1].content).toContain('The source is Markdown-formatted text.');
    expect(fixedTokenError(source, 'Väliaikainen __toimittajan__ lähde A')).toBeUndefined();
    const plain = {
      ...markdown,
      controls: [{ fieldId: 'body', widgetNamespace: 'builtin', widgetId: 'multipleLine' }],
    } as EditorSnapshot;
    expect(
      planRun(planTasks(plain, ['body'], 'en', ['fi']), options()).requests[0].request.fields[0].outputGuidance,
    ).not.toContain('The source is Markdown-formatted text.');
  });

  it('keeps Markdown guidance on plain-prose fields and every split part while distinguishing real placeholders', () => {
    const markdown = {
      ...snapshot,
      fields: {
        ...snapshot.fields,
        body: {
          en: 'A plain paragraph for the editor.\n\nAnother paragraph for the editor.\n\nKeep {editor} and `editor` unchanged.',
          fi: null,
        },
      },
      controls: [{ fieldId: 'body', widgetNamespace: 'builtin', widgetId: 'markdown' }],
    } as EditorSnapshot;
    const tasks = planTasks(markdown, ['body'], 'en', ['fi']);
    const plan = planRun(tasks, options({ requestSourceCharacters: 40 }));
    expect(plan.requests.length).toBeGreaterThan(1);
    for (const request of plan.requests)
      for (const work of request.request.fields) {
        expect(work.type).toBe('text');
        expect(work.outputGuidance).toContain('The source is Markdown-formatted text.');
      }
    const last = plan.requests.at(-1)?.request.fields.at(-1);
    expect(last?.outputGuidance).toContain('Preserve these placeholder occurrences exactly');
    expect(last?.outputGuidance).toContain('{editor}');
  });

  it('plans tasks in content-type order from stored values and marks Long text', () => {
    const tasks = planTasks(snapshot, ['rich', 'headline', 'tags', 'body'], 'en', ['fi', 'sv']);
    expect(tasks.map(task => task.key)).toEqual([
      'headline:fi',
      'headline:sv',
      'tags:fi',
      'tags:sv',
      'body:fi',
      'body:sv',
      'rich:fi',
      'rich:sv',
    ]);
    expect(tasks.filter(task => task.longText).map(task => task.fieldId)).toEqual(['body', 'body']);
    expect(tasks.every(task => task.targetSnapshot === null)).toBe(true);
  });

  it('groups every selected field per target locale into one request in field order', () => {
    const tasks = planTasks(snapshot, ['headline', 'tags', 'body', 'rich'], 'en', ['fi', 'sv']);
    const plan = planRun(tasks, options());
    expect(plan.requests.map(request => [request.targetLocale, request.request.fields.map(work => work.id)])).toEqual([
      ['fi', ['f-headline', 'f-tags', 'f-body', 'f-rich']],
      ['sv', ['f-headline', 'f-tags', 'f-body', 'f-rich']],
    ]);
    const tags = plan.requests[0].request.fields[1];
    // Whitespace-only items stay in the app.
    expect(tags).toMatchObject({
      type: 'array',
      items: [
        { id: 'i0', text: 'red, green' },
        { id: 'i2', text: 'blue' },
      ],
    });
    expect(plan.requests[0].request.context).toBeUndefined();
    expect(plan.warnings).toEqual([]);
  });

  it('respects the work field count and source budget, projecting absent siblings as context', () => {
    const tasks = planTasks(snapshot, ['headline', 'tags', 'body', 'rich'], 'en', ['fi']);
    const plan = planRun(tasks, options({ maxWorkFields: 2 }));
    expect(plan.requests.map(request => request.request.fields.map(work => work.fieldId))).toEqual([
      ['headline', 'tags'],
      ['body', 'rich'],
    ]);
    expect(plan.requests[0].request.context?.map(item => [item.role, item.fieldId, item.value])).toEqual([
      ['sibling', 'body', 'First paragraph.\n\nSecond paragraph.'],
      ['sibling', 'rich', 'Rich intro.'],
    ]);
    expect(plan.requests[0].dependencies.map(item => `${item.fieldId}:${item.locale}`)).toEqual([
      'headline:en',
      'headline:fi',
      'tags:en',
      'tags:fi',
      'body:en',
      'rich:en',
    ]);
  });

  it('gives explicit context priority over siblings within the configured budgets and reports omissions', () => {
    const tasks = planTasks(snapshot, ['headline', 'body'], 'en', ['fi']);
    const explicit = [
      {
        entryId: 'entry',
        fieldId: 'note',
        fieldName: 'Note',
        locale: 'en',
        provenance: 'current-editor' as const,
        rawValue: 'Note A.\n\nNote B is long.',
      },
      {
        entryId: 'other',
        fieldId: 'tagline',
        fieldName: 'Tagline',
        locale: 'fi',
        provenance: 'saved-entry' as const,
        rawValue: 'Tallennus',
        savedVersion: 7,
      },
    ];
    const plan = planRun(
      tasks,
      options(
        { maxWorkFields: 1, contextMaxFields: 2, contextFieldCharacters: 10, contextTotalCharacters: 100 },
        { explicitContext: explicit },
      ),
    );
    const [first] = plan.requests;
    expect(
      first.request.context?.map(item => [item.role, item.name, item.value, item.omittedUnits, item.version]),
    ).toEqual([
      ['explicit', 'Note', 'Note A.', 1, undefined],
      ['explicit', 'Tagline', 'Tallennus', 0, 7],
    ]);
    expect(first.omittedFields).toEqual(['Body']);
    expect(() => planRun(tasks, options({ contextMaxFields: 1 }, { explicitContext: explicit }))).toThrow(
      'Select at most 1 context fields',
    );
  });

  it('keeps Short text whole and splits Long text above the request size, whatever the backend', () => {
    const long = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`;
    const wide = {
      ...snapshot,
      fields: { ...snapshot.fields, headline: { en: 'x'.repeat(40) }, body: { en: long } },
    } as EditorSnapshot;
    const tasks = planTasks(wide, ['headline', 'body'], 'en', ['fi']);
    // Short text and a single paragraph never split; each is sent alone.
    const plan = planRun(tasks, options({ requestSourceCharacters: 25 }));
    expect(plan.requests.map(request => request.request.fields.map(work => work.id))).toEqual([
      ['f-headline'],
      ['f-body~0'],
      ['f-body~1'],
    ]);
    expect(plan.warnings.join(' ')).toContain(
      'Headline has 40 characters, above this model’s 25-character request size',
    );
    // A request size at or above the field's length keeps Long text whole.
    const whole = planRun(tasks, options({ requestSourceCharacters: 50_000 }));
    expect(whole.requests.map(request => request.request.fields.map(work => work.id))).toEqual([
      ['f-headline', 'f-body'],
    ]);
    const split = planRun(tasks, options({ requestSourceCharacters: 40 }));
    expect(
      split.requests.flatMap(request => request.request.fields.map(work => [work.id, work.part, work.parts])),
    ).toEqual([
      ['f-headline', undefined, undefined],
      ['f-body~0', 1, 2],
      ['f-body~1', 2, 2],
    ]);
    expect(split.requests[1].request.context?.map(item => [item.role, item.for, item.position, item.value])).toEqual([
      ['sibling', undefined, undefined, 'x'.repeat(40).slice(0, 40)],
      ['neighbor', 'f-body~0', 'after', 'b'.repeat(30)],
    ]);
  });

  it('cuts Long text at paragraphs, lines and sentences, never inside fenced code or tables', () => {
    const segments = (text: string) => {
      const { spans, penalties } = textSegments(text);
      return spans.map(([start, end], index) => [text.slice(start, end), penalties[index]]);
    };
    const text =
      '# Title\n\nIntro. Second sentence!\nline\n\n```\ncode\n\nmore. Not split\n```\n\n| a | b |\n| - | - |\n\n  \n## Next\nEnd e.g. here';
    expect(segments(text)).toEqual([
      ['# Title', 0],
      ['Intro.', 10],
      ['Second sentence!', 30],
      ['line', 20],
      ['```\ncode\n\nmore. Not split\n```', 10],
      ['| a | b |\n| - | - |', 10],
      ['## Next', 1],
      ['End e.g. here', 20],
    ]);
    expect(segments('Cited.[46][47] Next one.[b] "Quoted."')).toEqual([
      ['Cited.[46][47]', 10],
      ['Next one.[b]', 30],
      ['"Quoted."', 30],
    ]);
    expect(segments('\r\nOne\r\n\r\nTwo\r\nThree')).toEqual([
      ['One', 10],
      ['Two', 10],
      ['Three', 20],
    ]);
  });

  it('splits Long text without blank lines at line breaks', () => {
    // Pasted articles often separate paragraphs with single line breaks only.
    const lines = Array.from({ length: 6 }, (_, index) => `${'w'.repeat(98)}${index}.`);
    const wide = { ...snapshot, fields: { ...snapshot.fields, body: { en: lines.join('\n') } } } as EditorSnapshot;
    const tasks = planTasks(wide, ['body'], 'en', ['fi']);
    const plan = planRun(tasks, options({ requestSourceCharacters: 250 }));
    expect(plan.warnings).toEqual([]);
    expect(plan.requests.map(request => (request.request.fields[0] as { source: string }).source)).toEqual([
      lines.slice(0, 2).join('\n'),
      lines.slice(2, 4).join('\n'),
      lines.slice(4).join('\n'),
    ]);
    expect(plan.requests[1].request.context?.map(item => [item.position, item.value])).toEqual([
      ['before', lines.slice(0, 2).join('\n')],
      ['after', lines.slice(4).join('\n')],
    ]);
  });

  it('splits a 200,000-character Rich Text document into the fewest balanced parts at heading boundaries', () => {
    const blocks: unknown[] = [];
    for (let section = 0; section < 10; section++) {
      blocks.push(paragraph(`Section ${section}`, BLOCKS.HEADING_2));
      for (let index = 0; index < 10; index++) blocks.push(paragraph(`${'w'.repeat(1_997)}${section}${index}`));
    }
    const rich = document(...blocks);
    const big = { ...snapshot, fields: { ...snapshot.fields, rich: { en: rich } } } as EditorSnapshot;
    const tasks = planTasks(big, ['rich'], 'en', ['fi']);
    const plan = planRun(tasks, options());
    const sizes = plan.requests.map(request => request.sourceCharacters);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(199_900 + 10 * 'Section 0'.length);
    // The fewest parts, every one within the request size, each a section.
    expect(plan.requests).toHaveLength(10);
    expect(sizes).toEqual(Array.from({ length: 10 }, () => 19_999));
    for (const [index, request] of plan.requests.entries()) {
      const [work] = request.request.fields as RichTextWork[];
      expect([work.part, work.parts]).toEqual([index + 1, 10]);
      expect(work.source[0]).toMatchObject({ tag: 'h2', content: [`Section ${index}`] });
      if (index)
        expect(request.request.context?.find(item => item.role === 'outline')?.value).toContain('Document outline:');
    }
    // A layout with no natural heading cut still uses the fewest balanced parts.
    const uneven = document(
      ...Array.from({ length: 100 }, (_, index) => paragraph(`${'v'.repeat(1_999)}${index % 10}`)),
    );
    const unevenTasks = planTasks(
      { ...snapshot, fields: { ...snapshot.fields, rich: { en: uneven } } } as EditorSnapshot,
      ['rich'],
      'en',
      ['fi'],
    );
    const unevenSizes = planRun(unevenTasks, options()).requests.map(request => request.sourceCharacters);
    expect(unevenSizes).toEqual(Array.from({ length: 10 }, () => 20_000));
    // The same document stays whole when it fits the request size.
    expect(planRun(tasks, options({ requestSourceCharacters: 200_000 })).requests).toHaveLength(1);
  });

  it('reopens tables for split parts and fails an indivisible part that exceeds the byte limits before any call', () => {
    const cell = (tag: BLOCKS, text: string) => ({ nodeType: tag, data: {}, content: [paragraph(text)] });
    const row = (tag: BLOCKS, a: string, b: string) => ({
      nodeType: BLOCKS.TABLE_ROW,
      data: {},
      content: [cell(tag, a), cell(tag, b)],
    });
    const table = {
      nodeType: BLOCKS.TABLE,
      data: {},
      content: [
        row(BLOCKS.TABLE_HEADER_CELL, 'Plan', 'Price'),
        ...Array.from({ length: 6 }, (_, index) => row(BLOCKS.TABLE_CELL, `Row ${index} ${'x'.repeat(20)}`, '9 €')),
      ],
    };
    const doc = document(paragraph('Intro', BLOCKS.HEADING_1), table);
    const tasks = planTasks(
      { ...snapshot, fields: { ...snapshot.fields, rich: { en: doc } } } as EditorSnapshot,
      ['rich'],
      'en',
      ['fi'],
    );
    const plan = planRun(tasks, options({ requestSourceCharacters: 80 }));
    expect(plan.requests.length).toBeGreaterThan(1);
    const later = plan.requests[plan.requests.length - 1];
    expect((later.request.fields[0] as RichTextWork).source[0]).toMatchObject({ tag: 'table' });
    expect(later.request.context?.find(item => item.role === 'outline')?.value).toContain('Table header: Plan | Price');
    const huge = planTasks(
      { ...snapshot, fields: { ...snapshot.fields, headline: { en: 'x'.repeat(256) } } } as EditorSnapshot,
      ['headline'],
      'en',
      ['fi'],
    );
    expect(() =>
      planRun(
        huge,
        options({}, { limits: { requestBytes: 1_000, providerBodyBytes: 4 * 1_048_576, resultBytes: 4 * 1_048_576 } }),
      ),
    ).toThrow(PlanError);
  });

  it('halves grouped requests that exceed the backend byte limit', () => {
    const tasks = planTasks(snapshot, ['headline', 'tags', 'body'], 'en', ['fi']);
    const bytes = planRun(tasks, options()).requests[0].bytes;
    const plan = planRun(
      tasks,
      options(
        {},
        { limits: { requestBytes: bytes + 255, providerBodyBytes: 4 * 1_048_576, resultBytes: 4 * 1_048_576 } },
      ),
    );
    expect(plan.requests.length).toBeGreaterThan(1);
    expect(plan.requests.flatMap(request => request.request.fields.map(work => work.fieldId))).toEqual([
      'headline',
      'tags',
      'body',
    ]);
    expect(plan.requests.every(request => request.bytes + 256 <= bytes + 255)).toBe(true);
  });

  it('measures a part split for the byte limit with the context it will carry', () => {
    const doc = document(...Array.from({ length: 16 }, (_, index) => paragraph(`${'p'.repeat(498)}${index % 10}.`)));
    const wide = { ...snapshot, fields: { ...snapshot.fields, rich: { en: doc } } } as EditorSnapshot;
    const tasks = planTasks(wide, ['rich'], 'en', ['fi']);
    const legal = planRun(tasks, options({ requestSourceCharacters: 1_000 }));
    expect(legal.requests).toHaveLength(8);
    const requestBytes = Math.max(...legal.requests.map(request => request.bytes)) + 256;
    const limits = { requestBytes, providerBodyBytes: 4 * 1_048_576, resultBytes: 4 * 1_048_576 };
    // The whole document is over the byte limit, so the planner splits it;
    // the split parts' neighbor context must count before they are accepted.
    const plan = planRun(tasks, options({}, { limits }));
    expect(plan.requests.length).toBeGreaterThan(1);
    expect(plan.requests.every(request => request.bytes + 256 <= requestBytes)).toBe(true);
    expect(plan.requests[1].request.context?.map(item => item.role)).toEqual(['neighbor', 'neighbor']);
  });

  it('rejects source text a reader could not accept, naming the field', () => {
    const tasks = planTasks(
      { ...snapshot, fields: { ...snapshot.fields, headline: { en: 'Bell\u0007' } } } as EditorSnapshot,
      ['headline'],
      'en',
      ['fi'],
    );
    expect(() => planRun(tasks, options())).toThrow('Headline contains a control character');
  });

  it('warns when the estimated output exceeds the output allowance without blocking', () => {
    const tasks = planTasks(snapshot, ['body'], 'en', ['fi']);
    const plan = planRun(tasks, options({}, { outputAllowance: 10 }));
    expect(plan.requests).toHaveLength(1);
    expect(plan.warnings).toEqual([expect.stringContaining('output allowance')]);
    expect(planRun(tasks, options()).warnings).toEqual([]);
  });
});

describe('grouped run execution and retries', () => {
  const sources = () => new Map();

  it('sends exactly the previewed requests one at a time and assembles every field', async () => {
    const tasks = planTasks(snapshot, ['headline', 'tags', 'body', 'rich'], 'en', ['fi']);
    const plan = planRun(tasks, options());
    const sent: string[] = [];
    let active = 0;
    let peak = 0;
    const state = await runAll(startRun(plan), async request => {
      peak = Math.max(peak, ++active);
      sent.push(JSON.stringify(request));
      await Promise.resolve();
      active--;
      return reply(request);
    });
    expect(sent).toEqual(plan.requests.map(request => JSON.stringify(request.request)));
    expect(peak).toBe(1);
    const cache = sources();
    const results = tasks.map(task => taskResult(state, task, cache));
    expect(results.map(result => result?.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(results[0]?.suggestion).toBe('Hello {name} [fi example]');
    expect(results[1]?.suggestion).toEqual(['red, green [fi]', '  ', 'blue [fi]']);
    expect((results[3]?.suggestion as Document | undefined)?.content).toHaveLength(1);
  });

  it('restores edge whitespace, CRLF line endings and exact Long text separators', async () => {
    const body = '\n  First line.\r\nStill first.\r\n\r\n\r\n```\r\ncode\r\n```\r\n\r\nLast.  ';
    const wide = { ...snapshot, fields: { ...snapshot.fields, body: { en: body } } } as EditorSnapshot;
    const tasks = planTasks(wide, ['body'], 'en', ['fi']);
    // Each line, the fenced block and the last paragraph travel alone.
    const plan = planRun(tasks, options({ requestSourceCharacters: 20 }));
    expect(plan.requests.length).toBe(4);
    const state = await runAll(startRun(plan), async request =>
      reply(
        request,
        identity(request)
          .replaceAll('\r\n', '\n')
          .replace(/<field id="([^"]+)">/g, '<field id="$1">\n'),
      ),
    );
    expect(taskResult(state, tasks[0], sources())?.suggestion).toBe(body);
  });

  it('keeps successes, isolates field failures and retries only failed work with new IDs', async () => {
    const tasks = planTasks(snapshot, ['headline', 'tags'], 'en', ['fi']);
    const plan = planRun(tasks, options());
    let state = await runAll(startRun(plan), async request =>
      reply(
        request,
        `<translation><field id="f-headline">Hei {name}</field><field id="f-tags"><item id="i0">x</item></field></translation>`,
      ),
    );
    const cache = sources();
    expect(taskResult(state, tasks[0], cache)).toMatchObject({ status: 'ready', suggestion: 'Hei {name}' });
    expect(taskResult(state, tasks[1], cache)).toMatchObject({
      status: 'error',
      code: 'invalid_structure',
      rawSuggestion: 'x',
    });
    const retry = planRetry(tasks, options(), failedGroups(state, ['tags:fi']), false, keptRanges(state, ['tags:fi']));
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests[0].request.fields.map(work => work.id)).toEqual(['f-tags']);
    expect(retry.requests[0].request.requestId).not.toBe(plan.requests[0].request.requestId);
    // The sibling that succeeded stays as context, from the frozen source.
    expect(retry.requests[0].request.context?.map(item => item.fieldId)).toEqual(['headline']);
    state = retryRun(state, ['tags:fi'], retry);
    const send = vi.fn(async (request: TranslateRequest) => reply(request));
    state = await runAll(state, send);
    expect(send).toHaveBeenCalledOnce();
    expect(taskResult(state, tasks[0], cache)).toMatchObject({ status: 'ready', suggestion: 'Hei {name}' });
    expect(taskResult(state, tasks[1], cache)).toMatchObject({
      status: 'ready',
      suggestion: ['red, green [fi]', '  ', 'blue [fi]'],
    });
  });

  it('retries a timed-out group in smaller batches with exact coverage and successes kept', async () => {
    const items = Array.from({ length: 8 }, (_, index) => `Item ${index} ${'y'.repeat(20)}`);
    const wide = { ...snapshot, fields: { ...snapshot.fields, tags: { en: items } } } as EditorSnapshot;
    const tasks = planTasks(wide, ['headline', 'tags'], 'en', ['fi']);
    const plan = planRun(tasks, options());
    expect(plan.requests).toHaveLength(1);
    const timeout = Object.assign(new Error('Relay 504: provider_timeout'), { code: 'provider_timeout' });
    let state = await runAll(startRun(plan), async () => {
      throw timeout;
    });
    const cache = sources();
    const failed = taskResult(state, tasks[1], cache);
    expect(failed).toMatchObject({ status: 'error', code: 'provider_timeout' });
    expect(smallerRetryApplies(failed?.code)).toBe(true);
    expect(smallerRetryApplies('provider_rate_limited')).toBe(false);
    const keys = tasks.map(task => task.key);
    const smaller = planRetry(
      tasks,
      options({ retrySizeFactor: 0.5 }),
      failedGroups(state, keys),
      true,
      keptRanges(state, keys),
    );
    // Grouped fields separate first, then the list splits between items.
    expect(
      smaller.requests.map(request => request.request.fields.map(work => [work.id, work.part, work.parts])),
    ).toEqual([[['f-headline', undefined, undefined]], [['f-tags~0', 1, 2]], [['f-tags~4', 2, 2]]]);
    expect(Math.max(...smaller.requests.map(request => request.sourceCharacters))).toBeLessThan(
      plan.requests[0].sourceCharacters,
    );
    state = retryRun(state, keys, smaller);
    let call = 0;
    state = await runAll(state, async request => {
      // The second part times out again; the others finish.
      if (++call === 3) throw timeout;
      return reply(request);
    });
    expect(taskResult(state, tasks[0], cache)).toMatchObject({ status: 'ready' });
    expect(taskResult(state, tasks[1], cache)).toMatchObject({ status: 'error', code: 'provider_timeout' });
    const again = planRetry(
      tasks,
      options(),
      failedGroups(state, [tasks[1].key]),
      false,
      keptRanges(state, [tasks[1].key]),
    );
    expect(again.requests.map(request => request.request.fields.map(work => [work.id, work.part, work.parts]))).toEqual(
      [[['f-tags~4', 2, 2]]],
    );
    state = await runAll(retryRun(state, [tasks[1].key], again), async request => reply(request));
    expect(taskResult(state, tasks[1], cache)?.suggestion).toEqual(items.map(item => `${item} [fi]`));
  });

  it('separates a field that failed in a grouped request even when it cannot split itself', async () => {
    const tasks = planTasks(snapshot, ['headline', 'body'], 'en', ['fi']);
    const state = await runAll(startRun(planRun(tasks, options())), async () => {
      throw Object.assign(new Error('timeout'), { code: 'provider_timeout' });
    });
    const retry = planRetry(tasks, options(), failedGroups(state, [tasks[0].key]), true);
    expect(retry.unavailable).toBeUndefined();
    expect(retry.requests.map(request => request.request.fields.map(work => work.id))).toEqual([['f-headline']]);
  });

  it('explains when no smaller plan exists for an indivisible field', async () => {
    const tasks = planTasks(snapshot, ['headline'], 'en', ['fi']);
    const state = await runAll(startRun(planRun(tasks, options())), async () => {
      throw Object.assign(new Error('truncated'), { code: 'provider_truncated' });
    });
    const retry = planRetry(tasks, options(), failedGroups(state, [tasks[0].key]), true);
    expect(retry.requests).toEqual([]);
    expect(retry.unavailable).toContain('Headline cannot be split into smaller requests');
  });

  it('keeps the relay debug details of a failed request on its fields', async () => {
    const tasks = planTasks(snapshot, ['headline'], 'en', ['fi']);
    const state = await runAll(startRun(planRun(tasks, options())), async () => {
      throw new RelayError(502, 'invalid_provider_response', undefined, 'reason: <field> is not allowed here.');
    });
    expect(taskResult(state, tasks[0], sources())).toMatchObject({
      status: 'error',
      code: 'invalid_provider_response',
      debug: 'reason: <field> is not allowed here.',
    });
  });

  it('does not send a request whose dependencies changed and ignores replies after cancel', async () => {
    const tasks = planTasks(snapshot, ['headline'], 'en', ['fi', 'sv']);
    const plan = planRun(tasks, options());
    const live = structuredClone(snapshot);
    live.fields.headline.en = 'Changed';
    const send = vi.fn(async (request: TranslateRequest) => reply(request));
    const stale = await runAll(startRun(plan), send, dependencies => dependenciesCurrent(dependencies, live));
    expect(send).not.toHaveBeenCalled();
    expect(taskResult(stale, tasks[0], sources())).toMatchObject({ status: 'error', code: 'stale' });

    const controller = new AbortController();
    let value = startRun(plan);
    await executeRun(
      () => value,
      next => {
        value = next;
      },
      async request => {
        controller.abort();
        return reply(request);
      },
      controller.signal,
      () => true,
    );
    expect(value.requests.map(request => request.status)).toEqual(['cancelled', 'cancelled']);
    expect(taskResult(value, tasks[0], sources())?.status).toBe('cancelled');
  });

  it('applies grouped suggestions without treating earlier draft writes as sibling target conflicts', async () => {
    const tasks = planTasks(snapshot, ['headline', 'body'], 'en', ['fi']);
    const plan = planRun(tasks, options());
    expect(plan.requests).toHaveLength(1);
    const done = await runAll(startRun(plan), async request => reply(request, identity(request)));
    const live = structuredClone(snapshot);
    for (const task of tasks) {
      const result = taskResult(done, task, sources()) as TaskResult;
      expect(isCurrent(result, live)).toBe(true);
      const outcome = await applyTextDraft(
        {
          read: locale => live.fields[task.fieldId]?.[locale],
          isDisabled: () => false,
          write: async (value, locale) => {
            live.fields[task.fieldId][locale] = value;
          },
          dependenciesCurrent: () => dependenciesCurrent(result.dependencies ?? [], live),
        },
        {
          sourceLocale: task.sourceLocale,
          targetLocale: task.targetLocale,
          sourceSnapshot: task.sourceSnapshot,
          targetSnapshot: task.targetSnapshot,
          choice: 'suggestion',
          suggestion: result.suggestion as string,
        },
        async () => true,
      );
      expect(outcome.status).toBe('applied');
    }
    expect(live.fields.body.fi).toBe(snapshot.fields.body.en);
    // Each result still protects its own target and every source it used.
    const body = taskResult(done, tasks[1], sources()) as TaskResult;
    expect(isCurrent(body, live)).toBe(false);
    live.fields.body.fi = null;
    live.fields.headline.en = 'Changed source';
    expect(isCurrent(body, live)).toBe(false);
  });

  it('retains a grouped sibling target when it was explicitly sent as context', async () => {
    const live = structuredClone(snapshot);
    live.fields.headline.fi = 'Existing Finnish heading';
    const tasks = planTasks(live, ['headline', 'body'], 'en', ['fi']);
    const plan = planRun(
      tasks,
      options(
        {},
        {
          explicitContext: [
            {
              entryId: live.entryId,
              fieldId: 'headline',
              fieldName: 'Headline',
              locale: 'fi',
              provenance: 'current-editor',
              rawValue: live.fields.headline.fi,
            },
          ],
        },
      ),
    );
    expect(plan.requests).toHaveLength(1);
    const done = await runAll(startRun(plan), async request => reply(request, identity(request)));
    const body = taskResult(done, tasks[1], sources()) as TaskResult;
    expect(isCurrent(body, live)).toBe(true);
    live.fields.headline.fi = 'Changed context';
    expect(isCurrent(body, live)).toBe(false);
  });

  it('makes a result stale when a sibling value sent as context changes', async () => {
    const tasks = planTasks(snapshot, ['headline', 'body'], 'en', ['fi']);
    const plan = planRun(tasks, options({ maxWorkFields: 1 }));
    expect(plan.requests[1].request.context?.map(item => [item.role, item.fieldId])).toEqual([['sibling', 'headline']]);
    const done = await runAll(startRun(plan), async request => reply(request));
    const body = taskResult(done, tasks[1], sources());
    expect(body?.status).toBe('ready');
    const live = structuredClone(snapshot);
    expect(isCurrent(body as TaskResult, live)).toBe(true);
    live.fields.headline.en = 'Edited headline';
    // The body did not change, but the sibling it was translated with did.
    expect(isCurrent(body as TaskResult, live)).toBe(false);
    expect(isCurrent(tasks[1], live)).toBe(true);
  });

  it('fails a suggestion over twice the field limit and warns about changed reference-like text', async () => {
    const limited = {
      ...snapshot,
      fields: { ...snapshot.fields, headline: { en: 'Use &amp; here' } },
      definitions: [
        { id: 'headline', name: 'Headline', type: 'Symbol', localized: true, validations: [{ size: { max: 10 } }] },
      ],
    } as unknown as EditorSnapshot;
    const tasks = planTasks(limited, ['headline'], 'en', ['fi']);
    const plan = planRun(tasks, options());
    const run = (text: string) =>
      runAll(startRun(plan), async request =>
        reply(request, `<translation><field id="f-headline">${text}</field></translation>`),
      );
    expect(taskResult(await run('x'.repeat(21)), tasks[0], sources())).toMatchObject({
      status: 'error',
      code: 'too_long',
    });
    expect(taskResult(await run('Käytä &amp;amp; tässä'), tasks[0], sources())).toMatchObject({
      status: 'ready',
      detail: 'Suggested text violates the field size rule',
    });
    expect(taskResult(await run('Use &amp; here'), tasks[0], sources())).toMatchObject({
      status: 'ready',
      warning: expect.stringContaining('Reference-like text'),
    });
  });

  it('keeps a Rich Text suggestion that breaks a field rule reviewable and skips a source that already does', async () => {
    const limited = (max: number) =>
      ({
        ...snapshot,
        definitions: [
          { id: 'rich', name: 'Rich', type: 'RichText', localized: true, validations: [{ size: { max } }] },
        ],
      }) as unknown as EditorSnapshot;
    const tasks = planTasks(limited(15), ['rich'], 'en', ['fi']);
    const state = await runAll(startRun(planRun(tasks, options())), async request =>
      reply(request, mockResponseMarkup(request).replace('Rich intro.', 'Rikas johdanto, paljon pidempi.')),
    );
    expect(taskResult(state, tasks[0], sources())).toMatchObject({
      status: 'ready',
      detail: 'Rich Text violates the field size rule',
    });
    expect(planTasks(limited(5), ['rich'], 'en', ['fi'])).toEqual([]);
    expect(selectableFields(limited(5), 'en')).toEqual([]);
    expect(fieldSourceProblem(limited(5), limited(5).definitions[0], 'en')).toBe(
      'Rich Text violates the field size rule. Fix the source before translating.',
    );
  });

  it('treats whitespace-only sources as empty everywhere', () => {
    const blank = {
      ...snapshot,
      fields: {
        ...snapshot.fields,
        headline: { en: '  ' },
        tags: { en: [' ', ''] },
        rich: { en: document(paragraph(' ')) },
      },
    } as unknown as EditorSnapshot;
    expect(selectableFields(blank, 'en').map(field => field.id)).toEqual(['body']);
    expect(planTasks(blank, ['headline', 'tags', 'body', 'rich'], 'en', ['fi']).map(task => task.fieldId)).toEqual([
      'body',
    ]);
    expect(readyFieldCount(blank, 'en')).toBe(1);
  });

  it('retries every part of a field whose assembled suggestion failed validation', async () => {
    const limited = {
      ...snapshot,
      fields: { ...snapshot.fields, body: { en: `${'a'.repeat(30)}\n\n${'b'.repeat(30)}` } },
      definitions: [{ id: 'body', name: 'Body', type: 'Text', localized: true, validations: [{ size: { max: 70 } }] }],
    } as unknown as EditorSnapshot;
    const tasks = planTasks(limited, ['body'], 'en', ['fi']);
    const plan = planRun(tasks, options({ requestSourceCharacters: 40 }));
    expect(plan.requests).toHaveLength(2);
    // Each part is fine alone; together they exceed twice the field limit.
    let state = await runAll(startRun(plan), async request =>
      reply(request, `<translation><field id="${request.fields[0].id}">${'x'.repeat(80)}</field></translation>`),
    );
    const cache = sources();
    expect(taskResult(state, tasks[0], cache)).toMatchObject({ status: 'error', code: 'too_long' });
    const keys = [tasks[0].key];
    const groups = failedGroups(state, keys, cache);
    expect(groups.flatMap(group => group.parts.map(part => part.work.id))).toEqual(['f-body~0', 'f-body~1']);
    expect(keptRanges(state, keys, cache).size).toBe(0);
    const retry = planRetry(tasks, options({ requestSourceCharacters: 40 }), groups, false, new Map());
    expect(retry.requests).toHaveLength(2);
    state = await runAll(retryRun(state, keys, retry, cache), async request => reply(request));
    expect(taskResult(state, tasks[0], cache)).toMatchObject({ status: 'ready' });
  });

  it('reports parts from mixed settings or incomplete coverage as failures', async () => {
    const tasks: Task[] = planTasks(snapshot, ['tags'], 'en', ['fi']);
    const plan = planRun(tasks, options({ requestSourceCharacters: 5 }));
    const state = await runAll(startRun(plan), async request => ({
      ...reply(request),
      profileRevision: request.profileRevision,
    }));
    expect(taskResult(state, tasks[0], sources())?.status).toBe('ready');
    const broken: RunState = { ...state, parts: state.parts.slice(1) };
    expect(taskResult(broken, tasks[0], sources())).toMatchObject({ status: 'error', code: 'coverage' });
  });
});
