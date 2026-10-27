import type { RichTextWork, TranslateRequest, WorkField, WorkResult } from '../contract';
import {
  elementsOf,
  escapeText,
  type MarkupContext,
  type MarkupElement,
  MarkupError,
  normalizeMarkup,
  type ParserLimits,
  parseStrict,
  textOf,
} from './markup';
import {
  BLOCK_TAGS,
  INLINE_TAGS,
  type RichInline,
  readRichBlocks,
  readRichFormat,
  serializeBlocks,
  UNIT_TAGS,
  WorkFieldError,
} from './richtext';
import { ENVELOPE_TAGS, RICH_TEXT_VOCABULARY, serializeSource } from './serialize';

// A name that may not appear inside a value: a literal `<field>` would make
// the response ambiguous.
const RESERVED: ReadonlySet<string> = new Set(['field']);
const none: ReadonlySet<string> = new Set();

const textContext: MarkupContext = { tags: none, child: () => textContext };
const itemsContext: MarkupContext = { tags: new Set(['item']), child: () => textContext };
const inlineContext: MarkupContext = {
  tags: INLINE_TAGS,
  child: name => (name === 'br' ? textContext : inlineContext),
};
const blockContext: MarkupContext = {
  tags: BLOCK_TAGS,
  child: name =>
    (UNIT_TAGS as readonly string[]).includes(name)
      ? inlineContext
      : name === 'hr' || name === 'embed'
        ? textContext
        : blockContext,
};

function fieldContext(work: WorkField): MarkupContext {
  return work.type === 'text' ? textContext : work.type === 'array' ? itemsContext : blockContext;
}

// Models may echo a complete input wrapper or just its closing delimiter.
// Strip only at the field boundary. A text source that mentions source tags
// (also as escaped HTML examples) stays untouched for frontend review.
function unwrapSource(field: MarkupElement, work: WorkField): MarkupElement {
  const { children } = field;
  const first = children[0];
  const last = children[children.length - 1];
  if (typeof last !== 'string') return field;
  if (work.type === 'text' && /(?:<|&(?:amp;)*lt;)\/?source(?=[\s/>]|&(?:amp;)*gt;)/i.test(serializeSource(work)))
    return field;
  const open = typeof first === 'string' ? /^\s*<source>/.exec(first)?.[0] : undefined;
  const close = /<\/source>\s*$/.exec(last)?.[0];
  if (close === undefined) return field;
  const start = open?.length ?? 0;
  if (children.length === 1)
    return start + close.length > last.length
      ? field
      : { ...field, children: [last.slice(start, last.length - close.length)] };
  return {
    ...field,
    children: [
      typeof first === 'string' ? first.slice(start) : first,
      ...children.slice(1, -1),
      last.slice(0, last.length - close.length),
    ],
  };
}

// The response grammar for one request: only `<field>` is markup outside the
// fields, so the `<translation>` root, echoed `<fields>` or other wrappers,
// commentary and fences around them are ignored text. A field's context
// follows the requested type of its work ID, whatever `type` the response
// repeats; a field with another ID is read as text and ignored.
function responseContext(fields: readonly WorkField[]): MarkupContext {
  return {
    tags: RESERVED,
    envelope: true,
    child: (_name, attrs) => {
      const work = workOf(fields, attrs);
      return work ? fieldContext(work) : textContext;
    },
  };
}

// The requested work a result field answers: by its ID, or the only requested
// field when the result field has no ID.
function workOf(fields: readonly WorkField[], attrs: Readonly<Record<string, string>>): WorkField | undefined {
  if (attrs.id === undefined) return fields.length === 1 ? fields[0] : undefined;
  return fields.find(work => work.id === attrs.id);
}

function readText(element: MarkupElement): WorkResult {
  const value = textOf(element);
  if (value === undefined) throw new WorkFieldError('invalid_structure', 'A text field contains elements.');
  return { id: '', status: 'ok', type: 'text', text: value };
}

function readItems(element: MarkupElement): WorkResult {
  const elements = elementsOf(element);
  if (!elements) throw new WorkFieldError('invalid_items', 'The array must contain item elements.');
  const items = elements.map(item => {
    const value = textOf(item);
    if (item.name !== 'item' || !item.attrs.id || value === undefined)
      throw new WorkFieldError('invalid_items', 'An array item needs an ID and text.');
    return { id: item.attrs.id, text: value };
  });
  return { id: '', status: 'ok', type: 'array', items };
}

// The fields of a response under one synthetic root.
function documentOf(content: string, fields: readonly WorkField[], limits: ParserLimits): MarkupElement {
  return parseStrict(
    `<response>${normalizeMarkup(content, responseContext(fields), RESERVED, limits)}</response>`,
    limits,
  );
}

/**
 * Reads a model response by its `<field>` elements, wherever they are:
 * anything around them is ignored, and so are fields with unrequested IDs.
 * When one field was requested, a result field without an ID answers it.
 * Unreadable or truncated markup, a literal `<field>` inside a value and a
 * stray `</field>` fail the whole response; a missing, repeated or malformed
 * field fails alone. An echoed source wrapper or trailing closing delimiter
 * is removed when it is unambiguously request framing.
 * Only `id` is read from result fields and items, and values are read by the
 * requested type.
 * @returns One result per requested work field, in request order.
 * @throws MarkupError for a whole-response failure.
 */
export function readTranslationResponse(
  content: string,
  request: Pick<TranslateRequest, 'fields'>,
  limits: ParserLimits,
): WorkResult[] {
  const byId = new Map<string, MarkupElement[]>();
  for (const child of documentOf(content, request.fields, limits).children) {
    const work = typeof child === 'string' ? undefined : workOf(request.fields, child.attrs);
    if (work && typeof child !== 'string') byId.set(work.id, [...(byId.get(work.id) ?? []), child]);
  }
  return request.fields.map((work): WorkResult => {
    const [field, repeated] = byId.get(work.id) ?? [];
    if (!field) return { id: work.id, status: 'failed', error: 'missing' };
    if (repeated) return { id: work.id, status: 'failed', error: 'invalid_structure' };
    try {
      const element = unwrapSource(field, work);
      if (work.type === 'text') return { ...readText(element), id: work.id };
      if (work.type === 'array') return { ...readItems(element), id: work.id };
      return {
        id: work.id,
        status: 'ok',
        type: 'richText',
        markup: serializeBlocks(readRichFormat(element.children), RICH_TEXT_VOCABULARY),
      };
    } catch (error) {
      if (error instanceof WorkFieldError) return { id: work.id, status: 'failed', error: error.code };
      throw error;
    }
  });
}

/**
 * Reads canonical Rich Text markup that a backend returned for one work
 * field against its frozen source for frontend reconstruction. Review may
 * allow missing anchors; malformed markup and unmapped anchors still throw.
 * @returns The translated inline content by unit ID.
 * @throws MarkupError or WorkFieldError.
 */
export function readRichTextResult(
  markup: string,
  work: RichTextWork,
  limits: ParserLimits,
  options: { allowMissingAnchors?: boolean } = {},
): Map<string, RichInline[]> {
  const root = documentOf(`<field id="${work.id}">${markup}</field>`, [work], limits);
  // Canonical markup has nothing to ignore, so a closed field may not be followed by another.
  const [element, other] = root.children;
  if (typeof element !== 'object' || other !== undefined)
    throw new MarkupError('The Rich Text result is not one field.');
  return readRichBlocks(element.children, work.source, new Map(), options.allowMissingAnchors);
}

/** Reads format-valid Rich Text without comparing its content with a source. */
export function readRichTextMarkup(markup: string, work: RichTextWork, limits: ParserLimits) {
  const root = documentOf(`<field id="${work.id}">${markup}</field>`, [work], limits);
  const [field, other] = root.children;
  if (typeof field !== 'object' || other !== undefined) throw new MarkupError('The Rich Text result is not one field.');
  return readRichFormat(field.children);
}

/**
 * The deterministic stand-in answer of mock translation: text and items
 * marked with the target locale, Rich Text unchanged. It travels through the
 * same reader as a model response.
 */
export function mockResponseMarkup(request: Pick<TranslateRequest, 'fields' | 'targetLocale'>): string {
  const fields = request.fields.map(work => {
    const content =
      work.type === 'text'
        ? escapeText(`${work.source} [${request.targetLocale} example]`, ENVELOPE_TAGS)
        : work.type === 'array'
          ? work.items
              .map(
                item =>
                  `<item id="${item.id}">${escapeText(`${item.text} [${request.targetLocale}]`, ENVELOPE_TAGS)}</item>`,
              )
              .join('')
          : serializeSource(work);
    return `<field id="${work.id}" type="${work.type}">${content}</field>`;
  });
  return `<translation>${fields.join('')}</translation>`;
}
