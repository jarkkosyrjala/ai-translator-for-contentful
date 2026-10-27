import { attributes, codePoints, escapeText, type MarkupElement, textOf } from './markup';

// Rich Text work as a typed tree. Text blocks are units with an ID; their
// inline content carries anchor IDs scoped to the unit. Every other element
// is locked structure that the model must return unchanged.

export const MARK_TAGS = ['strong', 'em', 'u', 's', 'sup', 'sub', 'code'] as const;
export const UNIT_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
export const CONTAINER_TAGS = ['ul', 'ol', 'li', 'blockquote', 'table', 'tr', 'th', 'td'] as const;
export type MarkTag = (typeof MARK_TAGS)[number];
export type UnitTag = (typeof UNIT_TAGS)[number];
export type ContainerTag = (typeof CONTAINER_TAGS)[number];
export type EmbedKind = 'entry' | 'asset' | 'resource';

export type RichInline =
  | string
  | { mark: string; tag: MarkTag; children: RichInline[] }
  | { link: string; children: RichInline[] }
  | { break: string }
  | { placeholder: string; text: string }
  | { fixed: string; text: string }
  | { ref: string };
export type RichUnit = { unit: string; tag: UnitTag; content: RichInline[] };
export type RichContainer = { tag: ContainerTag; colspan?: number; rowspan?: number; children: RichBlock[] };
export type RichBlock = RichUnit | RichContainer | { tag: 'hr' } | { tag: 'embed'; kind: EmbedKind };

export const INLINE_TAGS: ReadonlySet<string> = new Set([...MARK_TAGS, 'a', 'br', 'span']);
export const BLOCK_TAGS: ReadonlySet<string> = new Set([...UNIT_TAGS, ...CONTAINER_TAGS, 'hr', 'embed']);

export const isUnit = (block: RichBlock): block is RichUnit => 'unit' in block;
export const isContainer = (block: RichBlock): block is RichContainer => 'children' in block;

// A field-local problem: this work field fails while valid siblings survive.
export class WorkFieldError extends Error {
  constructor(
    readonly code: 'missing' | 'empty' | 'invalid_items' | 'invalid_structure',
    message: string,
  ) {
    super(message);
  }
}

export function serializeInline(nodes: readonly RichInline[], vocabulary: ReadonlySet<string>): string {
  let result = '';
  for (const node of nodes) {
    if (typeof node === 'string') result += escapeText(node, vocabulary);
    else if ('mark' in node)
      result += `<${node.tag}${attributes([['data-mark', node.mark]])}>${serializeInline(node.children, vocabulary)}</${node.tag}>`;
    else if ('link' in node)
      result += `<a${attributes([['data-link', node.link]])}>${serializeInline(node.children, vocabulary)}</a>`;
    else if ('break' in node) result += `<br${attributes([['data-break', node.break]])}/>`;
    else if ('placeholder' in node)
      result += `<span${attributes([['data-placeholder', node.placeholder]])}>${escapeText(node.text, vocabulary)}</span>`;
    else if ('fixed' in node)
      result += `<span${attributes([['data-fixed', node.fixed]])}>${escapeText(node.text, vocabulary)}</span>`;
    else result += `<span${attributes([['data-ref', node.ref]])}/>`;
  }
  return result;
}

export function serializeBlocks(blocks: readonly RichBlock[], vocabulary: ReadonlySet<string>): string {
  let result = '';
  for (const block of blocks) {
    if (isUnit(block))
      result += `<${block.tag}${attributes([['id', block.unit]])}>${serializeInline(block.content, vocabulary)}</${block.tag}>`;
    else if (block.tag === 'hr') result += '<hr/>';
    else if (block.tag === 'embed') result += `<embed${attributes([['data-kind', block.kind]])}/>`;
    else
      result += `<${block.tag}${attributes([
        ['colspan', block.colspan],
        ['rowspan', block.rowspan],
      ])}>${serializeBlocks(block.children, vocabulary)}</${block.tag}>`;
  }
  return result;
}

export function richUnits(blocks: readonly RichBlock[], into: RichUnit[] = []): RichUnit[] {
  for (const block of blocks) {
    if (isUnit(block)) into.push(block);
    else if (isContainer(block)) richUnits(block.children, into);
  }
  return into;
}

// Visible characters of inline content, including locked placeholder and
// code text that the model reads for the sentence.
export function inlineText(nodes: readonly RichInline[]): string {
  let text = '';
  for (const node of nodes) {
    if (typeof node === 'string') text += node;
    else if ('children' in node) text += inlineText(node.children);
    else if ('text' in node) text += node.text;
    else if ('break' in node) text += '\n';
  }
  return text;
}

export function richSourceCharacters(blocks: readonly RichBlock[]): number {
  return richUnits(blocks).reduce((total, unit) => total + codePoints(inlineText(unit.content)), 0);
}

type Anchors = {
  marks: Map<string, MarkTag>;
  links: Set<string>;
  breaks: Set<string>;
  placeholders: Map<string, string>;
  fixed: Map<string, string>;
  refs: Set<string>;
};

export function unitAnchors(content: readonly RichInline[]): Anchors {
  const anchors: Anchors = {
    marks: new Map(),
    links: new Set(),
    breaks: new Set(),
    placeholders: new Map(),
    fixed: new Map(),
    refs: new Set(),
  };
  const visit = (nodes: readonly RichInline[]) => {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      if ('mark' in node) {
        anchors.marks.set(node.mark, node.tag);
        visit(node.children);
      } else if ('link' in node) {
        anchors.links.add(node.link);
        visit(node.children);
      } else if ('break' in node) anchors.breaks.add(node.break);
      else if ('placeholder' in node) anchors.placeholders.set(node.placeholder, node.text);
      else if ('fixed' in node) anchors.fixed.set(node.fixed, node.text);
      else anchors.refs.add(node.ref);
    }
  };
  visit(content);
  return anchors;
}

function onlyAttributes(element: MarkupElement, expected: Record<string, string>): boolean {
  const names = Object.keys(element.attrs);
  return names.length === Object.keys(expected).length && names.every(name => element.attrs[name] === expected[name]);
}

function invalid(message: string): never {
  throw new WorkFieldError('invalid_structure', message);
}

/** Reads the response vocabulary, without comparing it with the source. */
export function readRichFormat(children: MarkupElement['children']): RichBlock[] {
  const attr = (element: MarkupElement, name: string): string => {
    const value = element.attrs[name];
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,99}$/.test(value) || !onlyAttributes(element, { [name]: value }))
      invalid(`Invalid <${element.name}> attributes.`);
    return value;
  };
  const inline = (nodes: MarkupElement['children']): RichInline[] =>
    nodes.map(node => {
      if (typeof node === 'string') return node;
      if ((MARK_TAGS as readonly string[]).includes(node.name))
        return { mark: attr(node, 'data-mark'), tag: node.name as MarkTag, children: inline(node.children) };
      if (node.name === 'a') return { link: attr(node, 'data-link'), children: inline(node.children) };
      if (node.name === 'br' && !node.children.length) return { break: attr(node, 'data-break') };
      if (node.name === 'span') {
        const [key] = Object.keys(node.attrs);
        const id = attr(node, key);
        const value = textOf(node);
        if (key === 'data-placeholder' && value !== undefined) return { placeholder: id, text: value };
        if (key === 'data-fixed' && value !== undefined) return { fixed: id, text: value };
        if (key === 'data-ref' && !node.children.length) return { ref: id };
      }
      return invalid(`Invalid inline <${node.name}>.`);
    });
  const blocks: RichBlock[] = [];
  for (const node of children) {
    if (typeof node === 'string') {
      if (node.trim()) invalid('Text outside a Rich Text unit.');
      continue;
    }
    if ((UNIT_TAGS as readonly string[]).includes(node.name))
      blocks.push({ unit: attr(node, 'id'), tag: node.name as UnitTag, content: inline(node.children) });
    else if (node.name === 'hr' && onlyAttributes(node, {}) && !node.children.length) blocks.push({ tag: 'hr' });
    else if (node.name === 'embed' && !node.children.length) {
      const kind = attr(node, 'data-kind');
      if (!['entry', 'asset', 'resource'].includes(kind)) invalid('Invalid embed kind.');
      blocks.push({ tag: 'embed', kind: kind as EmbedKind });
    } else if ((CONTAINER_TAGS as readonly string[]).includes(node.name)) {
      const spans: { colspan?: number; rowspan?: number } = {};
      for (const [key, value] of Object.entries(node.attrs)) {
        if (
          !['td', 'th'].includes(node.name) ||
          !['colspan', 'rowspan'].includes(key) ||
          !/^[1-9]\d*$/.test(value) ||
          !Number.isSafeInteger(Number(value))
        )
          invalid(`Invalid <${node.name}> attributes.`);
        spans[key as 'colspan' | 'rowspan'] = Number(value);
      }
      blocks.push({ tag: node.name as ContainerTag, ...spans, children: readRichFormat(node.children) });
    } else invalid(`Invalid block <${node.name}>.`);
  }
  return blocks;
}

/**
 * Reads one unit's translated inline content. Formatting spans may move,
 * widen or split within the unit; links, breaks, placeholders, fixed text and
 * references must each occur exactly once. Returned text stays intact so
 * frontend review can warn about changed placeholders and code.
 * @throws WorkFieldError `invalid_structure`.
 */
export function readUnitContent(element: MarkupElement, source: RichUnit, allowMissingAnchors = false): RichInline[] {
  const anchors = unitAnchors(source.content);
  const counts = new Map<string, number>();
  const used = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const walk = (children: MarkupElement['children'], marks: readonly MarkTag[], inLink: boolean): RichInline[] => {
    const result: RichInline[] = [];
    for (const child of children) {
      if (typeof child === 'string') {
        if (typeof result[result.length - 1] === 'string') result[result.length - 1] += child;
        else if (child) result.push(child);
        continue;
      }
      const { name } = child;
      if ((MARK_TAGS as readonly string[]).includes(name)) {
        const id = child.attrs['data-mark'];
        if (!onlyAttributes(child, { 'data-mark': id }) || anchors.marks.get(id) !== name)
          invalid(`Changed or unknown mark ${id ?? name} in ${source.unit}.`);
        if (marks.includes(name as MarkTag)) invalid(`Nested ${name} mark in ${source.unit}.`);
        used(`m:${id}`);
        result.push({
          mark: id,
          tag: name as MarkTag,
          children: walk(child.children, [...marks, name as MarkTag], inLink),
        });
      } else if (name === 'a') {
        const id = child.attrs['data-link'];
        if (!onlyAttributes(child, { 'data-link': id }) || !anchors.links.has(id) || inLink)
          invalid(`Changed or unknown link ${id ?? ''} in ${source.unit}.`);
        used(`l:${id}`);
        result.push({ link: id, children: walk(child.children, [], true) });
      } else if (name === 'br') {
        const id = child.attrs['data-break'];
        if (!onlyAttributes(child, { 'data-break': id }) || !anchors.breaks.has(id) || child.children.length)
          invalid(`Changed or unknown break ${id ?? ''} in ${source.unit}.`);
        used(`b:${id}`);
        result.push({ break: id });
      } else if (name === 'span') {
        const [attribute] = Object.keys(child.attrs);
        const id = child.attrs[attribute];
        if (Object.keys(child.attrs).length !== 1) invalid(`Unexpected span attributes in ${source.unit}.`);
        if (attribute === 'data-placeholder' || attribute === 'data-fixed') {
          const values = attribute === 'data-placeholder' ? anchors.placeholders : anchors.fixed;
          const value = textOf(child);
          if (!values.has(id) || value === undefined)
            invalid(`Changed or unknown locked text ${id} in ${source.unit}.`);
          used(`${attribute}:${id}`);
          result.push(attribute === 'data-placeholder' ? { placeholder: id, text: value } : { fixed: id, text: value });
        } else if (attribute === 'data-ref') {
          if (!anchors.refs.has(id) || child.children.length || inLink)
            invalid(`Changed or unknown reference ${id} in ${source.unit}.`);
          used(`r:${id}`);
          result.push({ ref: id });
        } else invalid(`Unexpected span in ${source.unit}.`);
      } else invalid(`Unsupported element <${name}> in ${source.unit}.`);
    }
    return result;
  };
  const content = walk(element.children, [], false);
  for (const id of anchors.marks.keys())
    if (!allowMissingAnchors && !counts.get(`m:${id}`)) invalid(`Missing mark ${id} in ${source.unit}.`);
  const once: [string, Iterable<string>][] = [
    ['l', anchors.links],
    ['b', anchors.breaks],
    ['data-placeholder', anchors.placeholders.keys()],
    ['data-fixed', anchors.fixed.keys()],
    ['r', anchors.refs],
  ];
  for (const [kind, ids] of once)
    for (const id of ids)
      if (counts.get(`${kind}:${id}`) !== 1 && !(allowMissingAnchors && !counts.has(`${kind}:${id}`)))
        invalid(`Missing or repeated anchor ${id} in ${source.unit}.`);
  return content;
}

/**
 * Compares a returned Rich Text field with its source skeleton. Containers,
 * rules and embeds must match exactly with only separator whitespace between
 * them; units are read by {@link readUnitContent}.
 * @returns The translated units by unit ID.
 * @throws WorkFieldError `invalid_structure`.
 */
export function readRichBlocks(
  children: MarkupElement['children'],
  expected: readonly RichBlock[],
  into: Map<string, RichInline[]> = new Map(),
  allowMissingAnchors = false,
): Map<string, RichInline[]> {
  const elements: MarkupElement[] = [];
  for (const child of children) {
    if (typeof child !== 'string') elements.push(child);
    else if (child.trim()) invalid('Text outside a Rich Text unit.');
  }
  if (elements.length !== expected.length) invalid('Changed Rich Text block structure.');
  for (const [index, block] of expected.entries()) {
    const element = elements[index];
    if (isUnit(block)) {
      if (element.name !== block.tag || !onlyAttributes(element, { id: block.unit }))
        invalid(`Changed Rich Text unit ${block.unit}.`);
      into.set(block.unit, readUnitContent(element, block, allowMissingAnchors));
    } else if (block.tag === 'hr') {
      if (element.name !== 'hr' || !onlyAttributes(element, {}) || textOf(element)?.trim() !== '')
        invalid('Changed horizontal rule.');
    } else if (block.tag === 'embed') {
      if (element.name !== 'embed' || !onlyAttributes(element, { 'data-kind': block.kind }) || element.children.length)
        invalid('Changed embedded item.');
    } else {
      const expectedAttrs: Record<string, string> = {};
      if (block.colspan !== undefined) expectedAttrs.colspan = String(block.colspan);
      if (block.rowspan !== undefined) expectedAttrs.rowspan = String(block.rowspan);
      if (element.name !== block.tag || !onlyAttributes(element, expectedAttrs))
        invalid(`Changed Rich Text <${block.tag}>.`);
      readRichBlocks(element.children, block.children, into, allowMissingAnchors);
    }
  }
  return into;
}

// The source skeleton with translated unit content, for canonical output.
export function replaceUnits(blocks: readonly RichBlock[], units: ReadonlyMap<string, RichInline[]>): RichBlock[] {
  return blocks.map(block =>
    isUnit(block)
      ? { ...block, content: units.get(block.unit) ?? block.content }
      : isContainer(block)
        ? { ...block, children: replaceUnits(block.children, units) }
        : block,
  );
}
