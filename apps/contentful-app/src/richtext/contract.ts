import {
  inlineText,
  type MarkTag,
  type RichBlock,
  type RichInline,
  type UnitTag,
} from '@ai-translator-for-contentful/protocol';
import {
  BLOCKS,
  type Block,
  type Document,
  INLINES,
  type Inline,
  MARKS,
  type Text,
  validateRichTextDocument,
} from '@contentful/rich-text-types';
import { fixedTokenError, placeholderOccurrences } from '../app/placeholders';

const textBlocks = new Set<string>([
  BLOCKS.PARAGRAPH,
  BLOCKS.HEADING_1,
  BLOCKS.HEADING_2,
  BLOCKS.HEADING_3,
  BLOCKS.HEADING_4,
  BLOCKS.HEADING_5,
  BLOCKS.HEADING_6,
]);
const containerBlocks = new Set<string>([
  BLOCKS.DOCUMENT,
  BLOCKS.QUOTE,
  BLOCKS.OL_LIST,
  BLOCKS.UL_LIST,
  BLOCKS.LIST_ITEM,
  BLOCKS.TABLE,
  BLOCKS.TABLE_ROW,
  BLOCKS.TABLE_CELL,
  BLOCKS.TABLE_HEADER_CELL,
]);
const lockedBlocks = new Set<string>([
  BLOCKS.HR,
  BLOCKS.EMBEDDED_ENTRY,
  BLOCKS.EMBEDDED_ASSET,
  BLOCKS.EMBEDDED_RESOURCE,
]);
const inlineRefs = new Set<string>([INLINES.EMBEDDED_ENTRY, INLINES.EMBEDDED_RESOURCE]);
const links = new Set<string>([
  INLINES.HYPERLINK,
  INLINES.ENTRY_HYPERLINK,
  INLINES.ASSET_HYPERLINK,
  INLINES.RESOURCE_HYPERLINK,
]);
const markTags: Record<string, string> = {
  [MARKS.BOLD]: 'strong',
  [MARKS.ITALIC]: 'em',
  [MARKS.UNDERLINE]: 'u',
  [MARKS.CODE]: 'code',
  [MARKS.SUPERSCRIPT]: 'sup',
  [MARKS.SUBSCRIPT]: 'sub',
  [MARKS.STRIKETHROUGH]: 's',
};
// The model sees the document's block structure as familiar XHTML elements.
// Only text blocks carry a unit id; every other element is locked context.
const blockTags: Record<string, string> = {
  [BLOCKS.PARAGRAPH]: 'p',
  [BLOCKS.HEADING_1]: 'h1',
  [BLOCKS.HEADING_2]: 'h2',
  [BLOCKS.HEADING_3]: 'h3',
  [BLOCKS.HEADING_4]: 'h4',
  [BLOCKS.HEADING_5]: 'h5',
  [BLOCKS.HEADING_6]: 'h6',
  [BLOCKS.QUOTE]: 'blockquote',
  [BLOCKS.OL_LIST]: 'ol',
  [BLOCKS.UL_LIST]: 'ul',
  [BLOCKS.LIST_ITEM]: 'li',
  [BLOCKS.TABLE]: 'table',
  [BLOCKS.TABLE_ROW]: 'tr',
  [BLOCKS.TABLE_HEADER_CELL]: 'th',
  [BLOCKS.TABLE_CELL]: 'td',
  [BLOCKS.HR]: 'hr',
  [BLOCKS.EMBEDDED_ENTRY]: 'embed',
  [BLOCKS.EMBEDDED_ASSET]: 'embed',
  [BLOCKS.EMBEDDED_RESOURCE]: 'embed',
};
const embedKinds: Record<string, string> = {
  [BLOCKS.EMBEDDED_ENTRY]: 'entry',
  [BLOCKS.EMBEDDED_ASSET]: 'asset',
  [BLOCKS.EMBEDDED_RESOURCE]: 'resource',
};
const headingTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

type RichNode = Block | Inline | Text;
export type Unit = {
  id: string;
  tag: UnitTag;
  path: number[];
  // The model-facing inline content with anchor IDs scoped to this unit.
  content: RichInline[];
  readable: string;
  plainText: string;
  marks: Record<string, string>;
  links: Record<string, Inline>;
  refs: Record<string, Inline>;
  placeholders: Record<string, string>;
  fixed: Record<string, string>;
  breaks: string[];
};
// A leaf is a text block (unit) or a locked block, in document order. Split
// parts are contiguous leaf ranges. `size` counts readable source code points.
export type Leaf = { path: number[]; unit?: Unit; heading?: Unit; size: number };
export type Contract = { source: Document; units: Unit[]; leaves: Leaf[] };

function isText(node: RichNode): node is Text {
  return node.nodeType === 'text';
}
function isInline(node: RichNode): node is Inline {
  return links.has(node.nodeType) || inlineRefs.has(node.nodeType);
}
function isBlock(node: RichNode): node is Block {
  return Object.values(BLOCKS).includes(node.nodeType as BLOCKS);
}
const codePointLength = (value: string) => [...value].length;

function serializeUnit(node: Block, path: number[], id: string): Unit {
  const unit: Unit = {
    id,
    tag: blockTags[node.nodeType] as UnitTag,
    path,
    content: [],
    readable: '',
    plainText: '',
    marks: {},
    links: {},
    refs: {},
    placeholders: {},
    fixed: {},
    breaks: [],
  };
  let markNumber = 0,
    linkNumber = 0,
    refNumber = 0,
    placeholderNumber = 0,
    fixedNumber = 0,
    breakNumber = 0;
  const seenMarks = new Map<string, string>();
  let previousMarkSet = new Set<string>();
  function serialize(nodes: RichNode[], activeLink?: string): RichInline[] {
    const result: RichInline[] = [];
    for (const child of nodes) {
      if (isText(child)) {
        const ordered = [...child.marks].sort((a, b) => a.type.localeCompare(b.type));
        for (const mark of ordered)
          if (!(mark.type in markTags)) throw new Error(`Unsupported mark ${mark.type} at ${path.join('.')}`);
        const wrappers = ordered.map(mark => {
          const key = `${activeLink ?? ''}:${mark.type}`;
          let markId = previousMarkSet.has(key) ? seenMarks.get(key) : undefined;
          if (!markId) {
            markId = `m${markNumber++}`;
            seenMarks.set(key, markId);
          }
          unit.marks[markId] = mark.type;
          return { id: markId, tag: markTags[mark.type] as MarkTag };
        });
        previousMarkSet = new Set(ordered.map(mark => `${activeLink ?? ''}:${mark.type}`));
        const wrap = (content: RichInline) =>
          wrappers.reduceRight<RichInline>(
            (inner, wrapper) => ({ mark: wrapper.id, tag: wrapper.tag, children: [inner] }),
            content,
          );
        unit.plainText += child.value;
        if (ordered.some(mark => mark.type === MARKS.CODE)) {
          const fixedId = `f${fixedNumber++}`;
          unit.fixed[fixedId] = child.value;
          result.push(wrap({ fixed: fixedId, text: child.value }));
          unit.readable += child.value;
          continue;
        }
        const pieces = child.value.split('\n');
        for (let i = 0; i < pieces.length; i++) {
          if (i) {
            const breakId = `b${breakNumber++}`;
            unit.breaks.push(breakId);
            result.push(wrap({ break: breakId }));
            unit.readable += '\n';
          }
          let position = 0;
          for (const occurrence of placeholderOccurrences(pieces[i])) {
            const before = pieces[i].slice(position, occurrence.index);
            if (before) result.push(wrap(before));
            const placeholderId = `p${placeholderNumber++}`;
            unit.placeholders[placeholderId] = occurrence.value;
            result.push(wrap({ placeholder: placeholderId, text: occurrence.value }));
            position = occurrence.index + occurrence.value.length;
          }
          const rest = pieces[i].slice(position);
          if (rest) result.push(wrap(rest));
          unit.readable += pieces[i];
        }
      } else if (isInline(child) && links.has(child.nodeType)) {
        previousMarkSet = new Set();
        const linkId = `l${linkNumber++}`;
        unit.links[linkId] = child;
        result.push({ link: linkId, children: serialize(child.content as RichNode[], linkId) });
        previousMarkSet = new Set();
      } else if (isInline(child) && inlineRefs.has(child.nodeType)) {
        previousMarkSet = new Set();
        const refId = `r${refNumber++}`;
        unit.refs[refId] = child;
        result.push({ ref: refId });
        unit.readable += `[reference ${refId}]`;
      } else throw new Error(`Unsupported inline node ${child.nodeType} at ${path.join('.')}`);
    }
    return result;
  }
  unit.content = serialize(node.content as RichNode[]);
  return unit;
}

export function createContract(source: Document): Contract {
  if (source.nodeType !== BLOCKS.DOCUMENT) throw new Error('Expected Contentful document');
  const errors = validateRichTextDocument(source);
  if (errors.length) throw new Error(`Invalid source document: ${JSON.stringify(errors)}`);
  const units: Unit[] = [];
  const leaves: Leaf[] = [];
  let heading: Unit | undefined;
  function visit(node: Block | Document, path: number[]) {
    if (textBlocks.has(node.nodeType)) {
      const unit = serializeUnit(node as Block, path, `u${units.length}`);
      units.push(unit);
      leaves.push({ path, unit, heading, size: codePointLength(inlineText(unit.content)) });
      if (headingTags.has(unit.tag)) heading = unit;
      return;
    }
    if (lockedBlocks.has(node.nodeType)) {
      leaves.push({ path, heading, size: 0 });
      return;
    }
    if (!containerBlocks.has(node.nodeType)) throw new Error(`Unsupported block ${node.nodeType} at ${path.join('.')}`);
    for (const [index, child] of node.content.entries()) visit(child as Block, [...path, index]);
  }
  visit(source, []);
  return { source, units, leaves };
}

function locked(node: Block): RichBlock {
  return node.nodeType in embedKinds
    ? { tag: 'embed', kind: embedKinds[node.nodeType] as 'entry' | 'asset' | 'resource' }
    : { tag: 'hr' };
}

function cellSpan(node: Block): { colspan?: number; rowspan?: number } {
  const span: { colspan?: number; rowspan?: number } = {};
  for (const name of ['colspan', 'rowspan'] as const) {
    const value = node.data[name];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) span[name] = value;
  }
  return span;
}

function isPrefix(prefix: number[], path: number[]): boolean {
  return prefix.length <= path.length && prefix.every((index, depth) => path[depth] === index);
}

/**
 * The typed source of leaves [start, end): those leaves with every enclosing
 * block reopened, so lists, tables and quotes keep their structure.
 */
export function partSource(contract: Contract, start = 0, end = contract.leaves.length): RichBlock[] {
  const selected = contract.leaves.slice(start, end);
  const units = new Map<string, Unit>();
  const included = new Map<string, number[]>();
  for (const leaf of selected) {
    if (leaf.unit) units.set(leaf.path.join('.'), leaf.unit);
    for (let depth = 0; depth < leaf.path.length; depth++) {
      const key = leaf.path.slice(0, depth).join('.');
      const indexes = included.get(key) ?? [];
      if (indexes[indexes.length - 1] !== leaf.path[depth]) indexes.push(leaf.path[depth]);
      included.set(key, indexes);
    }
  }
  function build(node: Block, path: number[]): RichBlock {
    const unit = units.get(path.join('.'));
    if (unit) return { unit: unit.id, tag: unit.tag, content: unit.content };
    if (lockedBlocks.has(node.nodeType)) return locked(node);
    const children: RichBlock[] = [];
    for (const index of included.get(path.join('.')) ?? []) {
      const child = node.content[index];
      if (isBlock(child)) children.push(build(child, [...path, index]));
    }
    return {
      tag: blockTags[node.nodeType] as RichBlock['tag'],
      ...cellSpan(node),
      children,
    } as RichBlock;
  }
  return (included.get('') ?? []).map(index => build(contract.source.content[index] as Block, [index]));
}

// Readable headings in document order, with Markdown-style levels.
export function headingOutline(contract: Contract): string[] {
  return contract.units
    .filter(unit => headingTags.has(unit.tag))
    .map(unit => `${'#'.repeat(Number(unit.tag.slice(1)))} ${unit.readable.replace(/\s+/g, ' ').trim()}`);
}

// The header row of the table a part reopens after its first row.
export function reopenedTableHeader(contract: Contract, start: number): string | undefined {
  const leaf = contract.leaves[start];
  if (!leaf) return undefined;
  for (let depth = leaf.path.length - 1; depth >= 1; depth--) {
    const tablePath = leaf.path.slice(0, depth);
    let node: Block | Document = contract.source;
    for (const index of tablePath) node = node.content[index] as Block;
    if (node.nodeType !== BLOCKS.TABLE) continue;
    if (leaf.path[depth] === 0) return undefined;
    const row = node.content[0];
    if (!row || !isBlock(row) || !row.content.some(cell => cell.nodeType === BLOCKS.TABLE_HEADER_CELL))
      return undefined;
    return row.content
      .map((_, index) =>
        contract.units
          .filter(unit => isPrefix([...tablePath, 0, index], unit.path))
          .map(unit => unit.readable)
          .join(' '),
      )
      .join(' | ');
  }
  return undefined;
}

/**
 * Builds Contentful inline nodes. Reference targets always come from the
 * source; review retains returned locked text so changes produce warnings.
 */
function rebuildUnit(
  unit: Unit,
  content: RichInline[],
  allowTextWarnings = false,
  allowSourceChanges = false,
): (Inline | Text)[] {
  function walk(nodes: RichInline[], marks: string[]): (Inline | Text)[] {
    const result: (Inline | Text)[] = [];
    const text = (value: string) => {
      if (value)
        result.push({ nodeType: 'text', value, marks: marks.map(type => ({ type: type as MARKS })), data: {} });
    };
    for (const node of nodes) {
      if (typeof node === 'string') text(node);
      else if ('mark' in node)
        result.push(
          ...walk(node.children, [
            ...marks,
            allowSourceChanges
              ? (Object.keys(markTags).find(kind => markTags[kind] === node.tag) as string)
              : unit.marks[node.mark],
          ]),
        );
      else if ('link' in node) {
        if (!unit.links[node.link]) throw new Error(`Unknown link ${node.link}; its target is unavailable`);
        result.push({ ...unit.links[node.link], content: walk(node.children, []) } as Inline);
      } else if ('break' in node) text('\n');
      else if ('placeholder' in node)
        text(allowSourceChanges || allowTextWarnings ? node.text : unit.placeholders[node.placeholder]);
      else if ('fixed' in node) text(allowSourceChanges || allowTextWarnings ? node.text : unit.fixed[node.fixed]);
      else {
        if (!unit.refs[node.ref]) throw new Error(`Unknown reference ${node.ref}; its target is unavailable`);
        result.push(structuredClone(unit.refs[node.ref]));
      }
    }
    const merged: (Inline | Text)[] = [];
    for (const node of result) {
      const previous = merged[merged.length - 1];
      if (
        node.nodeType === 'text' &&
        previous?.nodeType === 'text' &&
        JSON.stringify(previous.marks) === JSON.stringify(node.marks)
      )
        previous.value += node.value;
      else merged.push(node);
    }
    return merged;
  }
  const rebuilt = walk(content, []);
  function plain(nodes: (Inline | Text)[]): string {
    return nodes
      .map(node =>
        node.nodeType === 'text' ? node.value : 'content' in node ? plain(node.content as (Inline | Text)[]) : '',
      )
      .join('');
  }
  if (!allowTextWarnings) {
    const tokenError = fixedTokenError(unit.plainText, plain(rebuilt));
    if (tokenError) throw new Error(tokenError);
  }
  return rebuilt.length ? rebuilt : [{ nodeType: 'text', value: '', marks: [], data: {} }];
}

/** Converts a changed, format-valid response for review. Targets still come from the source. */
export function reconstructChangedPart(contract: Contract, blocks: RichBlock[], start: number, end: number): Block[] {
  const units = new Map(contract.units.map(unit => [unit.id, unit]));
  const locked = contract.leaves
    .slice(start, end)
    .filter(leaf => !leaf.unit)
    .map(leaf => {
      let node: Block | Document = contract.source;
      for (const index of leaf.path) node = node.content[index] as Block;
      return node as Block;
    });
  let lockedIndex = 0;
  const returnedLocked: string[] = [];
  const collectLocked = (nodes: RichBlock[]) => {
    for (const block of nodes) {
      if (block.tag === 'hr') returnedLocked.push(BLOCKS.HR);
      else if (block.tag === 'embed') returnedLocked.push(`embed:${block.kind}`);
      else if ('children' in block) collectLocked(block.children);
    }
  };
  collectLocked(blocks);
  if (
    returnedLocked.some(kind => kind.startsWith('embed:')) &&
    JSON.stringify(returnedLocked) !==
      JSON.stringify(
        locked.map(node => (node.nodeType === BLOCKS.HR ? BLOCKS.HR : `embed:${embedKinds[node.nodeType]}`)),
      )
  )
    throw new Error('Embedded item targets cannot be matched to the changed structure');
  const convert = (block: RichBlock): Block => {
    if ('unit' in block) {
      const original = units.get(block.unit);
      const unit = original ?? ({ marks: {}, links: {}, refs: {}, placeholders: {}, fixed: {}, plainText: '' } as Unit);
      return {
        nodeType: Object.keys(blockTags).find(kind => blockTags[kind] === block.tag) as BLOCKS,
        data: {},
        content: rebuildUnit(unit, block.content, true, true),
      } as Block;
    }
    if (block.tag === 'hr') {
      if (locked[lockedIndex]?.nodeType === BLOCKS.HR) lockedIndex++;
      return { nodeType: BLOCKS.HR, data: {}, content: [] };
    }
    if (block.tag === 'embed') {
      // Embeds carry no target in model markup. Never guess an added or changed target.
      const original = locked[lockedIndex++];
      if (!original || embedKinds[original.nodeType] !== block.kind)
        throw new Error('An embedded item target is unavailable');
      return structuredClone(original);
    }
    return {
      nodeType: Object.keys(blockTags).find(kind => blockTags[kind] === block.tag) as BLOCKS,
      data: {
        ...(block.colspan === undefined ? {} : { colspan: block.colspan }),
        ...(block.rowspan === undefined ? {} : { rowspan: block.rowspan }),
      },
      content: block.children.map(convert),
    } as Block;
  };
  return blocks.map(convert);
}

/** Joins containers reopened at an original split boundary, without merging distinct blocks. */
export function joinChangedParts(left: Block[], right: Block[], before: number[], after: number[], depth = 0): Block[] {
  const last = left.at(-1),
    first = right[0];
  if (
    depth < Math.min(before.length, after.length) - 1 &&
    before[depth] === after[depth] &&
    last &&
    first &&
    last.nodeType === first.nodeType &&
    containerBlocks.has(last.nodeType) &&
    JSON.stringify(last.data) === JSON.stringify(first.data)
  )
    return [
      ...left.slice(0, -1),
      {
        ...last,
        content: joinChangedParts(last.content as Block[], first.content as Block[], before, after, depth + 1),
      } as Block,
      ...right.slice(1),
    ];
  return [...left, ...right];
}

/**
 * Rebuilds the document from translated units. Every unit must be present;
 * structure, link targets and references are copied from the source.
 */
export function reconstruct(
  contract: Contract,
  units: ReadonlyMap<string, RichInline[]>,
  options: { allowTextWarnings?: boolean } = {},
): Document {
  if (units.size !== contract.units.length || contract.units.some(unit => !units.has(unit.id)))
    throw new Error('Unit ID mismatch');
  const result = structuredClone(contract.source);
  for (const unit of contract.units) {
    let children: RichNode[] = result.content;
    let node: Block | undefined;
    for (const index of unit.path) {
      const child = children[index];
      if (!child || !isBlock(child)) throw new Error(`Invalid Rich Text unit path ${unit.path.join('.')}`);
      node = child;
      children = child.content;
    }
    if (!node) throw new Error(`Invalid Rich Text unit path ${unit.path.join('.')}`);
    node.content = rebuildUnit(unit, units.get(unit.id) as RichInline[], options.allowTextWarnings);
  }
  const errors = validateRichTextDocument(result);
  if (errors.length) throw new Error(`Rebuilt document invalid: ${JSON.stringify(errors)}`);
  return result;
}
