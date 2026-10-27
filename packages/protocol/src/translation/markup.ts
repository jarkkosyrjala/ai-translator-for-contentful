import { parseXml, XmlElement, XmlNode, XmlText } from '@rgrove/parse-xml';

// Lexical rules of the custom translation markup, shared by the request
// serializer and the response reader. Text is written with bare characters:
// only `<` that would begin markup and `&` that would begin a reference are
// escaped, so the model can answer with plain `&`, `<` and `>`.

export type MarkupElement = { name: string; attrs: Record<string, string>; children: MarkupChild[] };
export type MarkupChild = MarkupElement | string;

// The element names a reader recognizes in one position. Everything else,
// including `<p>` in ordinary text or `<unknown>` in Rich Text, stays text.
export type MarkupContext = {
  readonly tags: ReadonlySet<string>;
  // Text around the recognized elements that a reader ignores, where
  // declarations, comments and processing instructions are text too.
  readonly envelope?: boolean;
  child(name: string, attrs: Readonly<Record<string, string>>): MarkupContext;
};

export type ParserLimits = { nodes: number; depth: number };

export const MAX_ATTRIBUTES = 16;
export const MAX_ATTRIBUTE_CODE_POINTS = 4_096;

// A syntax, identity or bound problem that makes the whole response unusable.
export class MarkupError extends Error {}

const reference = /&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/y;
const nameChars = /[A-Za-z][A-Za-z0-9]*/y;
const attributeName = /[^\s=/>"'<]+/y;
const space = /[ \t\n\r]/;

// XML 1.0 characters: tab, newline, carriage return, and the ranges below.
// Lone surrogates, other C0 controls, U+FFFE and U+FFFF cannot be read back.
export function illegalCharacter(value: string): number | undefined {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++;
        continue;
      }
      return index;
    }
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0xdc00 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff
    )
      return index;
  }
  return undefined;
}

export function codePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

// The name after `<` or `</` at `start` when it ends at a name boundary:
// whitespace, `>` or `/>`. With `endBoundary`, the end of the value counts too.
function tagName(value: string, start: number, endBoundary = false): string | undefined {
  nameChars.lastIndex = start;
  const match = nameChars.exec(value);
  if (!match) return undefined;
  const after = start + match[0].length;
  if (after === value.length) return endBoundary ? match[0] : undefined;
  const next = value[after];
  if (space.test(next) || next === '>' || (next === '/' && value[after + 1] === '>')) return match[0];
  return undefined;
}

/**
 * Serializes source text verbatim, except a `<` that would begin a tag named
 * in `vocabulary`, a declaration, comment or processing instruction, and an
 * `&` that would begin a reference. A reader decodes either exactly once.
 */
export function escapeText(value: string, vocabulary: ReadonlySet<string>): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '&') {
      reference.lastIndex = index;
      result += reference.test(value) ? '&amp;' : '&';
    } else if (char === '<') {
      const next = value[index + 1];
      const start = next === '/' ? index + 2 : index + 1;
      const name = next === '!' || next === '?' ? '!' : tagName(value, start, true);
      result += name && (name === '!' || vocabulary.has(name)) ? '&lt;' : '<';
    } else result += char;
  }
  return result;
}

export function escapeAttribute(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '&') {
      reference.lastIndex = index;
      result += reference.test(value) ? '&amp;' : '&';
    } else if (char === '"') result += '&quot;';
    else if (char === '\n') result += '&#10;';
    else if (char === '\r') result += '&#13;';
    else if (char === '\t') result += '&#9;';
    else result += char;
  }
  return result;
}

export function attributes(values: [string, string | number | undefined][]): string {
  return values
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeAttribute(String(value))}"`)
    .join('');
}

// Text and attribute values rewritten for a strict XML parser: literal `&`,
// `<` and `>` become references, carriage returns survive line-end
// normalization, and recognized references stay for one decoding.
function strictText(value: string, attribute: boolean): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '&') {
      reference.lastIndex = index;
      const match = reference.exec(value);
      if (match) {
        result += match[0];
        index += match[0].length - 1;
      } else result += '&amp;';
    } else if (char === '<') result += '&lt;';
    else if (char === '>') result += '&gt;';
    else if (char === '\r') result += '&#13;';
    else if (attribute && char === '"') result += '&quot;';
    else if (attribute && char === '\n') result += '&#10;';
    else if (attribute && char === '\t') result += '&#9;';
    else result += char;
  }
  return result;
}

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// Decodes recognized references once; other `&` stays literal.
export function decodeReferences(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/g, (match, body: string) => {
    if (body[0] !== '#') return named[body];
    const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

type Open = { name: string; context: MarkupContext };

/**
 * Tokenizes model output by position: only names the current context lists
 * are tags, and quoted `>` never ends a tag. Closing tags of open elements are
 * always recognized, so a literal `</field>` cannot hide inside a value.
 * Returns a strict XML document for parse-xml.
 * @throws MarkupError for declarations, comments, CDATA and processing
 *   instructions outside an envelope, namespaces, reserved names out of place,
 *   mismatched or unfinished tags, and exceeded bounds.
 */
export function normalizeMarkup(
  input: string,
  root: MarkupContext,
  reserved: ReadonlySet<string>,
  limits: ParserLimits,
): string {
  const stack: Open[] = [{ name: '', context: root }];
  let output = '';
  let text = '';
  let nodes = 0;
  // Text in an envelope is dropped.
  const flush = () => {
    if (text) {
      if (!stack[stack.length - 1].context.envelope) output += strictText(text, false);
      text = '';
    }
  };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char !== '<') {
      text += char;
      continue;
    }
    const next = input[index + 1];
    const top = stack[stack.length - 1];
    if (next === '!' || next === '?') {
      if (top.context.envelope) {
        text += char;
        continue;
      }
      throw new MarkupError('Declarations, comments, CDATA and processing instructions are not allowed.');
    }
    if (next === '/') {
      const name = tagName(input, index + 2);
      if (!name || !(top.context.tags.has(name) || stack.some(open => open.name === name) || reserved.has(name))) {
        text += char;
        continue;
      }
      let end = index + 2 + name.length;
      while (space.test(input[end] ?? '')) end++;
      if (input[end] !== '>') throw new MarkupError(`Malformed closing tag </${name}>.`);
      if (name !== top.name) throw new MarkupError(`Unexpected closing tag </${name}>.`);
      flush();
      output += `</${name}>`;
      stack.pop();
      index = end;
      continue;
    }
    const name = tagName(input, index + 1);
    if (!name || !(top.context.tags.has(name) || reserved.has(name))) {
      text += char;
      continue;
    }
    if (!top.context.tags.has(name)) throw new MarkupError(`<${name}> is not allowed here.`);
    let position = index + 1 + name.length;
    const attrs: Record<string, string> = {};
    const names = new Set<string>();
    let rendered = '';
    let selfClosing = false;
    for (;;) {
      while (space.test(input[position] ?? '')) position++;
      if (position >= input.length) throw new MarkupError(`Unfinished tag <${name}>.`);
      if (input[position] === '>') break;
      if (input[position] === '/' && input[position + 1] === '>') {
        selfClosing = true;
        position++;
        break;
      }
      attributeName.lastIndex = position;
      const attribute = attributeName.exec(input)?.[0];
      if (!attribute) throw new MarkupError(`Malformed attribute in <${name}>.`);
      if (attribute.includes(':') || attribute === 'xmlns' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(attribute))
        throw new MarkupError(`Attribute ${attribute} is not allowed.`);
      position += attribute.length;
      while (space.test(input[position] ?? '')) position++;
      if (input[position] !== '=') throw new MarkupError(`Attribute ${attribute} has no value.`);
      position++;
      while (space.test(input[position] ?? '')) position++;
      const quote = input[position];
      if (quote !== '"' && quote !== "'") throw new MarkupError(`Attribute ${attribute} is not quoted.`);
      const close = input.indexOf(quote, position + 1);
      if (close < 0) throw new MarkupError(`Unfinished attribute ${attribute}.`);
      const raw = input.slice(position + 1, close);
      // A Set, since the protocol avoids ES2022 library calls for the Function.
      if (names.has(attribute)) throw new MarkupError(`Duplicate attribute ${attribute}.`);
      if (names.size >= MAX_ATTRIBUTES) throw new MarkupError('Too many attributes.');
      names.add(attribute);
      if (codePoints(raw) > MAX_ATTRIBUTE_CODE_POINTS) throw new MarkupError(`Attribute ${attribute} is too long.`);
      attrs[attribute] = decodeReferences(raw);
      rendered += ` ${attribute}="${strictText(raw, true)}"`;
      position = close + 1;
    }
    if (++nodes > limits.nodes) throw new MarkupError('The response has too many elements.');
    if (!selfClosing && stack.length > limits.depth) throw new MarkupError('The response is nested too deeply.');
    flush();
    output += `<${name}${rendered}${selfClosing ? '/>' : '>'}`;
    // The context decides by raw attribute values, which carry no markup. It
    // also checks identity, so it runs for self-closing elements too.
    const context = top.context.child(name, attrs);
    if (!selfClosing) stack.push({ name, context });
    index = position;
  }
  flush();
  if (stack.length > 1) throw new MarkupError(`Unclosed <${stack[stack.length - 1].name}>; the response is truncated.`);
  return output;
}

// Node kinds parse-xml keeps only on request, so they fail here instead of
// being dropped or read as text.
const forbidden: Record<string, string> = {
  [XmlNode.TYPE_DOCUMENT_TYPE]: 'Doctype is not allowed.',
  [XmlNode.TYPE_PROCESSING_INSTRUCTION]: 'Processing instructions are not allowed.',
  [XmlNode.TYPE_COMMENT]: 'Comments are not allowed.',
  [XmlNode.TYPE_CDATA]: 'CDATA is not allowed.',
};

/**
 * Parses a normalized document with parse-xml, without namespaces or entities
 * other than XML's five and character references, each decoded once.
 * parse-xml builds the whole tree before returning, so `normalizeMarkup`
 * bounds the input; the bounds are checked again while reading the tree.
 * @throws MarkupError for anything that is not one well-formed element.
 */
export function parseStrict(xml: string, limits: ParserLimits): MarkupElement {
  let document: ReturnType<typeof parseXml>;
  try {
    document = parseXml(xml, { preserveCdata: true, preserveComments: true, preserveDocumentType: true });
  } catch (error) {
    throw new MarkupError(error instanceof Error ? error.message : String(error));
  }
  let nodes = 0;
  const read = (element: XmlElement, depth: number): MarkupElement => {
    if (++nodes > limits.nodes || depth > limits.depth)
      throw new MarkupError('The response exceeds the parser bounds.');
    const attrs: Record<string, string> = {};
    for (const name of Object.keys(element.attributes)) attrs[name] = element.attributes[name];
    const children: MarkupChild[] = [];
    for (const child of element.children) {
      const message = forbidden[child.type];
      if (message) throw new MarkupError(message);
      if (child instanceof XmlElement) children.push(read(child, depth + 1));
      else if (child instanceof XmlText) children.push(child.text);
    }
    return { name: element.name, attrs, children };
  };
  let root: MarkupElement | undefined;
  for (const child of document.children) {
    const message = forbidden[child.type];
    if (message) throw new MarkupError(message);
    if (child instanceof XmlElement) root = read(child, 1);
  }
  if (!root) throw new MarkupError('The response has no complete root element.');
  return root;
}

// Text-only children of an element, or undefined when it has element children.
export function textOf(element: MarkupElement): string | undefined {
  let text = '';
  for (const child of element.children) {
    if (typeof child !== 'string') return undefined;
    text += child;
  }
  return text;
}

// The element children of a structural position, where only separator
// whitespace may stand between them.
export function elementsOf(element: MarkupElement): MarkupElement[] | undefined {
  const elements: MarkupElement[] = [];
  for (const child of element.children) {
    if (typeof child === 'string') {
      if (child.trim()) return undefined;
    } else elements.push(child);
  }
  return elements;
}
