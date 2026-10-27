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
} from '@ai-translator-for-contentful/protocol';
import type { ContentTypeField } from '@contentful/app-sdk';
import { documentToReactComponents } from '@contentful/rich-text-react-renderer';
import {
  BLOCKS,
  type Block,
  type Document,
  INLINES,
  type Inline,
  MARKS,
  type Text,
  type TopLevelBlock,
} from '@contentful/rich-text-types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { planTasks } from '../src/app/batch';
import type { EditorSnapshot } from '../src/app/editor-snapshot';
import { planRun } from '../src/app/planner';
import { executeRun, startRun, taskResult } from '../src/app/run';
import { type Contract, createContract, partSource, reconstruct, type Unit } from '../src/richtext/contract';
import { rebuildRichText } from '../src/richtext/editor';

const t = (value: string, marks: string[] = []): Text => ({
  nodeType: 'text',
  value,
  marks: marks.map(type => ({ type })),
  data: {},
});
const block = <T extends BLOCKS>(
  nodeType: T,
  content: (Block | Inline | Text)[],
  data: Block['data'] = {},
): Block & { nodeType: T } => ({ nodeType, data, content });
const doc = (...content: TopLevelBlock[]): Document => ({ nodeType: BLOCKS.DOCUMENT, data: {}, content });
const link = (content: (Inline | Text)[]): Inline => ({
  nodeType: INLINES.HYPERLINK,
  data: { uri: 'https://example.test/path' },
  content,
});
const ref = (id: string): Inline => ({
  nodeType: INLINES.EMBEDDED_ENTRY,
  data: { target: { sys: { id, type: 'Link', linkType: 'Entry' } } },
  content: [],
});
const source = doc(
  block(BLOCKS.HEADING_2, [t('A heading')]),
  block(BLOCKS.PARAGRAPH, [
    t('Hello '),
    t('bold ', [MARKS.BOLD]),
    t('and ', [MARKS.BOLD]),
    t('italic', [MARKS.ITALIC, MARKS.UNDERLINE]),
    t(' link '),
    link([t('here', [MARKS.BOLD])]),
    t(' then\nagain  '),
    ref('entry-1'),
    t(' <tag> & end'),
    t(' const x = 1', [MARKS.CODE]),
  ]),
  block(BLOCKS.UL_LIST, [
    block(BLOCKS.LIST_ITEM, [
      block(BLOCKS.PARAGRAPH, [t('First')]),
      block(BLOCKS.UL_LIST, [block(BLOCKS.LIST_ITEM, [block(BLOCKS.PARAGRAPH, [t('Nested')])])]),
    ]),
  ]),
  block(BLOCKS.TABLE, [
    block(BLOCKS.TABLE_ROW, [
      block(BLOCKS.TABLE_HEADER_CELL, [block(BLOCKS.PARAGRAPH, [t('Head')])]),
      block(BLOCKS.TABLE_CELL, [block(BLOCKS.PARAGRAPH, [t('Cell')])]),
    ]),
  ]),
  block(BLOCKS.EMBEDDED_ENTRY, [], { target: { sys: { id: 'block-1', type: 'Link', linkType: 'Entry' } } }),
);

const parser = { nodes: DEFAULT_LIMITS.parserNodes, depth: DEFAULT_LIMITS.parserDepth };
// One unit's and a whole document's canonical model-facing markup.
const fragmentOf = (unit: Unit) =>
  serializeBlocks([{ unit: unit.id, tag: unit.tag, content: unit.content }], RICH_TEXT_VOCABULARY);
const markupOf = (contract: Contract) => serializeBlocks(partSource(contract), RICH_TEXT_VOCABULARY);
const workOf = (contract: Contract): RichTextWork => ({
  id: 'f-body',
  fieldId: 'body',
  name: 'Body',
  type: 'richText',
  source: partSource(contract),
});
// Reads a document's markup with units replaced, as a model response.
function snippets(contract: Contract, changes: Record<string, string> = {}): Map<string, RichInline[]> {
  let markup = markupOf(contract);
  for (const unit of contract.units) if (changes[unit.id]) markup = markup.replace(fragmentOf(unit), changes[unit.id]);
  return readRichTextResult(markup, workOf(contract), parser);
}
const linkTarget = (document: Document) =>
  document.content[1].content.find(node => node.nodeType === INLINES.HYPERLINK)?.data.uri;

function textSemantics(document: Document): string[] {
  const result: string[] = [];
  function visit(node: Document | Block | Inline | Text) {
    if (node.nodeType === 'text')
      for (const char of node.value)
        result.push(
          `${char}:${node.marks
            .map(mark => mark.type)
            .sort()
            .join('+')}`,
        );
    else for (const child of node.content) visit(child);
  }
  visit(document);
  return result;
}

function visible(document: Document): string {
  function visit(node: Document | Block | Inline | Text): string {
    if (node.nodeType === 'text') return node.value;
    if (node.nodeType === INLINES.EMBEDDED_ENTRY) return '[ref]';
    return node.content.map(visit).join('');
  }
  return visit(document);
}

describe('restricted Rich Text contract', () => {
  it('round trips adjacent marks, link, break, inline/block references, nested list and table', () => {
    const contract = createContract(source);
    expect(contract.units).toHaveLength(6);
    const rebuilt = reconstruct(contract, snippets(contract));
    expect(visible(rebuilt)).toBe(visible(source));
    expect(textSemantics(rebuilt)).toEqual(textSemantics(source));
    expect(rebuilt.content[1].content.find(node => node.nodeType === INLINES.EMBEDDED_ENTRY)?.data.target.sys.id).toBe(
      'entry-1',
    );
    expect(rebuilt.content.at(-1)?.data.target.sys.id).toBe('block-1');
    expect(rebuilt.content.map(n => n.nodeType)).toEqual(source.content.map(n => n.nodeType));
    expect(linkTarget(rebuilt)).toBe('https://example.test/path');
    expect(contract.units[1].readable).toContain(
      'bold and italic link here then\nagain  [reference r0] <tag> & end const x = 1',
    );
    expect(fragmentOf(contract.units[1])).toContain('data-mark="m0"');
    // Bare characters and non-vocabulary tags stay literal text.
    expect(fragmentOf(contract.units[1])).toContain('<span data-ref="r0"/> <tag> & end');
  });
  it('preserves marks around explicit line breaks', () => {
    const sample = doc(block(BLOCKS.PARAGRAPH, [t('line one\nline two', [MARKS.BOLD])]));
    const contract = createContract(sample);
    const rebuilt = reconstruct(contract, snippets(contract));
    expect(textSemantics(rebuilt)).toEqual(textSemantics(sample));
  });
  it('round trips Contentful strikethrough without dropping the mark', () => {
    const sample = doc(block(BLOCKS.PARAGRAPH, [t('keep '), t('old', [MARKS.STRIKETHROUGH]), t(' new')]));
    const contract = createContract(sample);
    expect(fragmentOf(contract.units[0])).toContain('<s data-mark="m0">old</s>');
    const rebuilt = reconstruct(contract, snippets(contract));
    expect(textSemantics(rebuilt)).toEqual(textSemantics(sample));
  });
  it('allows a mark to widen, move, and split into same-kind spans', () => {
    const contract = createContract(doc(block(BLOCKS.PARAGRAPH, [t('Hello '), t('world', [MARKS.BOLD]), t('!')])));
    const id = Object.keys(contract.units[0].marks)[0];
    const moved = `<p id="u0"><strong data-mark="${id}">Bonjour</strong> le monde<strong data-mark="${id}"> entier</strong> !</p>`;
    const rebuilt = reconstruct(contract, snippets(contract, { u0: moved }));
    const nodes = rebuilt.content[0].content;
    expect(
      nodes.filter(node => node.nodeType === 'text' && node.marks.some(mark => mark.type === MARKS.BOLD)),
    ).toHaveLength(2);
    expect(visible(rebuilt)).toBe('Bonjour le monde entier !');
  });
  it.each([
    ['lost link', (s: string) => s.replace(/<a data-link="l0">.*?<\/a>/, 'plain')],
    ['duplicate link', (s: string) => s.replace('</p>', '<a data-link="l0">again</a></p>')],
    ['lost break', (s: string) => s.replace(/<br data-break="b0"\/>/, '')],
    ['duplicate break', (s: string) => s.replace('</p>', '<br data-break="b0"/></p>')],
    ['lost reference', (s: string) => s.replace('<span data-ref="r0"/>', '')],
    ['duplicate reference', (s: string) => s.replace('</p>', '<span data-ref="r0"/></p>')],
    [
      'changed reference target',
      (s: string) => s.replace('<span data-ref="r0"/>', '<span data-ref="r0" data-target="other"/>'),
    ],
    [
      'changed link target',
      (s: string) => s.replace('<a data-link="l0">', '<a data-link="l0" href="https://evil.test">'),
    ],
    ['unknown inline element', (s: string) => s.replace('Hello ', '<strong>bad</strong>')],
    ['parser repair', (s: string) => s.replace('</p>', '')],
    ['literal reserved delimiter', (s: string) => s.replace('Hello ', 'Hello </field> ')],
    ['unknown attribute', (s: string) => s.replace('<p id="u1">', '<p id="u1" class="x">')],
    ['changed block tag', (s: string) => s.replace('<p id="u1">', '<h2 id="u1">').replace(/<\/p>$/, '</h2>')],
    ['element inside locked code', (s: string) => s.replace(' const x = 1</span>', '<em>const</em></span>')],
  ])('rejects %s', (_name, change) => {
    const contract = createContract(source);
    const changed = change(fragmentOf(contract.units[1]));
    expect(changed).not.toBe(fragmentOf(contract.units[1]));
    expect(() => reconstruct(contract, snippets(contract, { u1: changed }))).toThrow();
  });
  it('keeps non-vocabulary tags and bare characters in translated units as text', () => {
    const contract = createContract(source);
    const changed = fragmentOf(contract.units[1]).replace('Hello ', 'Hei <script>bad</script> & ');
    const rebuilt = reconstruct(contract, snippets(contract, { u1: changed }));
    expect(visible(rebuilt)).toContain('Hei <script>bad</script> & bold');
  });
  it('rejects unknown source nodes and malformed document', () => {
    expect(() => createContract(doc(block('unsupported' as BLOCKS, [t('x')]) as unknown as TopLevelBlock))).toThrow();
    expect(() =>
      createContract({ nodeType: BLOCKS.DOCUMENT, data: {}, content: [t('bad') as unknown as TopLevelBlock] }),
    ).toThrow();
  });
  it('shows why the React renderer cannot be used as the inverse contract', () => {
    const contract = createContract(source);
    const html = renderToStaticMarkup(documentToReactComponents(source, { preserveWhitespace: true }));
    expect(html).toContain('<b>');
    expect(html).not.toContain('data-mark="m0"');
    expect(fragmentOf(contract.units[1])).toContain('data-mark="m0"');
  });
});

const asset = block(BLOCKS.EMBEDDED_ASSET, [], { target: { sys: { id: 'asset-1', type: 'Link', linkType: 'Asset' } } });
const cell = (nodeType: BLOCKS.TABLE_CELL | BLOCKS.TABLE_HEADER_CELL, value: string, data: Block['data'] = {}) =>
  block(nodeType, [block(BLOCKS.PARAGRAPH, [t(value)])], data);
const structured = doc(
  block(BLOCKS.HEADING_2, [t('Pricing')]),
  block(BLOCKS.UL_LIST, [
    block(BLOCKS.LIST_ITEM, [
      block(BLOCKS.PARAGRAPH, [t('Free plan')]),
      block(BLOCKS.OL_LIST, [block(BLOCKS.LIST_ITEM, [block(BLOCKS.PARAGRAPH, [t('One user')])])]),
    ]),
    block(BLOCKS.LIST_ITEM, [block(BLOCKS.PARAGRAPH, [t('Pro plan')])]),
  ]),
  asset,
  block(BLOCKS.QUOTE, [block(BLOCKS.PARAGRAPH, [t('Best deal')])]),
  block(BLOCKS.HR, []),
  block(BLOCKS.TABLE, [
    block(BLOCKS.TABLE_ROW, [cell(BLOCKS.TABLE_HEADER_CELL, 'Plan & price', { colspan: 2 })]),
    block(BLOCKS.TABLE_ROW, [cell(BLOCKS.TABLE_CELL, 'Free'), cell(BLOCKS.TABLE_CELL, 'None')]),
  ]),
);
const field: ContentTypeField = { id: 'body', name: 'Body', type: 'RichText', localized: true, required: false };

function cellText(document: Document, row: number, column: number): string {
  const node = document.content[5]?.content[row];
  const target = node && 'content' in node ? node.content[column] : undefined;
  return target ? visible({ nodeType: BLOCKS.DOCUMENT, data: {}, content: [target as TopLevelBlock] }) : '';
}

const rebuild = (document: Document, markup: string) =>
  rebuildRichText(document, readRichTextResult(markup, workOf(createContract(document)), parser));

describe('structured Rich Text field', () => {
  const markup = markupOf(createContract(structured));

  it('shows headings, lists, quotes, tables, rules, and embeds to the model', () => {
    expect(markup).toBe(
      [
        '<h2 id="u0">Pricing</h2>',
        '<ul><li><p id="u1">Free plan</p><ol><li><p id="u2">One user</p></li></ol></li>',
        '<li><p id="u3">Pro plan</p></li></ul>',
        '<embed data-kind="asset"/>',
        '<blockquote><p id="u4">Best deal</p></blockquote>',
        '<hr/>',
        '<table><tr><th colspan="2"><p id="u5">Plan & price</p></th></tr>',
        '<tr><td><p id="u6">Free</p></td><td><p id="u7">None</p></td></tr></table>',
      ].join(''),
    );
  });

  it('rebuilds translated cells in place and tolerates indentation between blocks', () => {
    const response = markup
      .replace('>Free</p>', '>Ilmainen</p>')
      .replace('>None</p>', '>Ei mitään</p>')
      .replace(/></g, '>\n    <');
    const rebuilt = rebuild(structured, response);
    expect(cellText(rebuilt, 1, 0)).toBe('Ilmainen');
    expect(cellText(rebuilt, 1, 1)).toBe('Ei mitään');
    expect(rebuilt.content.map(node => node.nodeType)).toEqual(structured.content.map(node => node.nodeType));
    expect(rebuilt.content[2]).toEqual(asset);
    expect(rebuilt.content[5].content[0]).toMatchObject({ content: [{ data: { colspan: 2 } }] });
  });

  it.each([
    ['changed heading level', (s: string) => s.replace('<h2 id="u0">Pricing</h2>', '<h3 id="u0">Pricing</h3>')],
    ['changed list type', (s: string) => s.replace('<ol>', '<ul>').replace('</ol>', '</ul>')],
    ['dropped rule', (s: string) => s.replace('<hr/>', '')],
    ['added rule', (s: string) => s.replace('<hr/>', '<hr/><hr/>')],
    ['dropped embed', (s: string) => s.replace('<embed data-kind="asset"/>', '')],
    ['changed embed kind', (s: string) => s.replace('data-kind="asset"', 'data-kind="entry"')],
    ['changed cell span', (s: string) => s.replace('colspan="2"', 'colspan="1"')],
    [
      'header cell turned into data cell',
      (s: string) => s.replace('<th colspan="2">', '<td colspan="2">').replace('</th>', '</td>'),
    ],
    [
      'reordered list items',
      (s: string) =>
        s
          .replace('<p id="u3">Pro plan</p>', '<p id="u1">Free plan</p>')
          .replace('<p id="u1">Free plan</p><ol>', '<p id="u3">Pro plan</p><ol>'),
    ],
    [
      'unit moved out of its quote',
      (s: string) => s.replace('<blockquote><p id="u4">Best deal</p></blockquote>', '<p id="u4">Best deal</p>'),
    ],
    ['text between blocks', (s: string) => s.replace('<hr/>', 'stray<hr/>')],
    ['unit marked read-only', (s: string) => s.replace('<p id="u4">', '<p id="u4" translate="no">')],
    ['missing unit', (s: string) => s.replace('<p id="u7">None</p>', '')],
    ['flat legacy unit', (s: string) => s.replace('<p id="u7">None</p>', '<unit id="u7">None</unit>')],
  ])('rejects %s', (_name, change) => {
    const response = change(markup);
    expect(response).not.toBe(markup);
    expect(() => rebuild(structured, response)).toThrow();
  });

  it('splits a large table between leaves with its heading and header row as outline context', async () => {
    const long = (label: string) => `${label} ${'word '.repeat(180)}`.trim();
    const rows = Array.from({ length: 12 }, (_, index) =>
      block(BLOCKS.TABLE_ROW, [cell(BLOCKS.TABLE_CELL, long(`Name ${index}`)), cell(BLOCKS.TABLE_CELL, `${index} €`)]),
    );
    const table = doc(
      block(BLOCKS.HEADING_2, [t('Prices')]),
      block(BLOCKS.TABLE, [
        block(BLOCKS.TABLE_ROW, [cell(BLOCKS.TABLE_HEADER_CELL, 'Plan'), cell(BLOCKS.TABLE_HEADER_CELL, 'Price')]),
        ...rows,
      ]),
    );
    const snapshot = {
      entryId: 'entry',
      contentTypeId: 'page',
      defaultLocale: 'en',
      locales: ['en', 'fi'],
      fields: { body: { en: table, fi: null } },
      definitions: [field],
      controls: [{ fieldId: 'body', widgetNamespace: 'builtin', widgetId: 'richTextEditor' }],
    } as unknown as EditorSnapshot;
    const tasks = planTasks(snapshot, ['body'], 'en', ['fi']);
    const plan = planRun(tasks, {
      settings: resolveTranslationSettings({ requestSourceCharacters: 3_000 }, 20_000),
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
      envelope: request => request,
      id: () => crypto.randomUUID(),
    });
    expect(plan.requests.length).toBeGreaterThan(1);
    expect(plan.requests.every(request => request.sourceCharacters <= 3_000)).toBe(true);
    // The first part gets the outline and the source after it, never a table header.
    expect(plan.requests[0].request.context?.map(item => [item.role, item.position])).toEqual([
      ['outline', undefined],
      ['neighbor', 'after'],
    ]);
    expect(plan.requests[0].request.context?.[0].value).not.toContain('Table header');
    for (const request of plan.requests.slice(1)) {
      const [work] = request.request.fields as RichTextWork[];
      expect(work.source).toMatchObject([{ tag: 'table' }]);
      const outline = request.request.context?.find(item => item.role === 'outline');
      expect(outline).toMatchObject({ for: work.id });
      expect(outline?.value).toContain('Continues under: Prices');
      expect(outline?.value).toContain('Table header: Plan | Price');
    }
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
        results: readTranslationResponse(mockResponseMarkup(request).replace(/ €</g, ' euroa<'), request, parser),
      }),
      new AbortController().signal,
      () => true,
    );
    const result = taskResult(state, tasks[0], new Map());
    expect(result?.status).toBe('ready');
    const rebuilt = result?.suggestion as Document;
    expect(visible(rebuilt)).toBe(visible(table).replace(/ €/g, ' euroa'));
    expect(rebuilt.content[0]).toEqual(table.content[0]);
  });
});
