import { ENVELOPE_TAGS } from '@ai-translator-for-contentful/protocol';

const placeholderPattern = /\{\{[A-Za-z_][\w.:-]*\}\}|\$\{[A-Za-z_][\w.:-]*\}|\{[A-Za-z_][\w.:-]*\}|%(?:\d+\$)?[sdif]/g;
const urlPattern = /https?:\/\/[^\s<>"']+/g;
const identifierPattern = /\b(?:[A-Za-z]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9_]{1,})\b/g;

const count = (value: string, char: string) => value.split(char).length - 1;
// As in GitHub Flavored Markdown autolinks, trailing punctuation and an
// unbalanced closing bracket end a URL, so `[lake](https://x.test/Lake).`
// and its translation share the URL `https://x.test/Lake`.
function trimUrl(url: string): string {
  const last = url.slice(-1);
  const open = last === ')' ? '(' : last === ']' ? '[' : undefined;
  if (/[.,:;!?*_~]/.test(last) || (open && count(url, last) > count(url, open))) return trimUrl(url.slice(0, -1));
  return url;
}
const urls = (value: string) => (value.match(urlPattern) ?? []).map(trimUrl);

const tokens = (value: string, pattern: RegExp) => (value.match(pattern) ?? []).sort();
const equalTokens = (a: string[], b: string[]) =>
  a.length === b.length && a.every((token, index) => token === b[index]);

export function placeholders(value: string): string[] {
  return tokens(value, placeholderPattern);
}

export function placeholderOccurrences(value: string): { index: number; value: string }[] {
  return [...value.matchAll(placeholderPattern)].map(match => ({ index: match.index, value: match[0] }));
}

export function preservesPlaceholders(source: string, suggestion: string): boolean {
  return equalTokens(placeholders(source), placeholders(suggestion));
}

function identifiers(value: string): string[] {
  return tokens(
    value.replace(placeholderPattern, ' ').replace(urlPattern, url => ` ${url.slice(trimUrl(url).length)}`),
    identifierPattern,
  );
}

export function fixedTokenError(source: string, suggestion: string): string | undefined {
  if (!preservesPlaceholders(source, suggestion)) return 'Suggested text changed placeholders';
  if (!equalTokens(urls(source).sort(), urls(suggestion).sort())) return 'Suggested text changed URLs';
  if (!equalTokens(identifiers(source), identifiers(suggestion))) return 'Suggested text changed identifiers';
}

// Ordinary text and Markdown may legitimately include these tags. Warn only
// about additional request tags, retaining the full suggestion for review.
function requestTags(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of value.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g)) {
    if (!ENVELOPE_TAGS.has(match[2])) continue;
    const tag = `<${match[1]}${match[2]}>`;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

export function textIntegrityError(source: string, suggestion: string): string | undefined {
  const sourceTags = requestTags(source);
  for (const [tag, count] of requestTags(suggestion))
    if (count > (sourceTags.get(tag) ?? 0)) return `Suggested text added request markup (${tag})`;
  const fixedError = fixedTokenError(source, suggestion);
  if (fixedError) return fixedError;
  if (
    (source.match(/^\s*/) ?? [''])[0] !== (suggestion.match(/^\s*/) ?? [''])[0] ||
    (source.match(/\s*$/) ?? [''])[0] !== (suggestion.match(/\s*$/) ?? [''])[0] ||
    !equalTokens(tokens(source, /\r\n|\r|\n/g), tokens(suggestion, /\r\n|\r|\n/g))
  )
    return 'Suggested text changed whitespace or line breaks';
}

export function restoreOuterWhitespace(source: string, suggestion: string): string {
  if (!source.trim()) return suggestion;
  const leading = (source.match(/^\s*/) ?? [''])[0];
  const trailing = (source.match(/\s*$/) ?? [''])[0];
  return leading + suggestion.trim() + trailing;
}

// Line endings follow the source when it uses CRLF throughout.
export function restoreLineEndings(source: string, suggestion: string): string {
  if (!source.includes('\r\n') || /(^|[^\r])\n/.test(source)) return suggestion;
  return suggestion.replace(/\r?\n/g, '\r\n');
}

export function restoreText(source: string, suggestion: string): string {
  return restoreLineEndings(source, restoreOuterWhitespace(source, suggestion));
}

// Literal reference-like text such as `&amp;` is easy for a model to decode;
// a changed count is shown as an editable warning.
const referenceLike = /&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9A-Fa-f]+);/g;
export function referenceWarning(source: string, suggestion: string): string | undefined {
  const count = (value: string) => (value.match(referenceLike) ?? []).length;
  if (count(source) !== count(suggestion))
    return 'Reference-like text such as &amp; changed. Check that it should read as written.';
}

export function outputGuidance(source: string, size?: { min?: number; max?: number }, format?: 'markdown'): string {
  const rules: string[] = [];
  if (format === 'markdown')
    rules.push(
      'The source is Markdown-formatted text. Translate its content, including formatted words, while preserving Markdown formatting.',
    );
  else rules.push('Preserve existing markup and formatting. Do not add formatting to plain text.');
  if (size?.min !== undefined) rules.push(`Use at least ${size.min} Unicode characters.`);
  if (size?.max !== undefined) rules.push(`Use at most ${size.max} Unicode characters.`);
  const tokens = placeholders(source);
  if (tokens.length)
    rules.push(
      `Preserve these placeholder occurrences exactly, allowing them to move with the sentence: ${JSON.stringify(tokens)}.`,
    );
  const sourceUrls = urls(source);
  if (sourceUrls.length) rules.push(`Preserve these URLs exactly: ${JSON.stringify(sourceUrls)}.`);
  const ids = identifiers(source);
  if (ids.length) rules.push(`Preserve these identifiers exactly: ${JSON.stringify(ids)}.`);
  rules.push('Preserve leading and trailing whitespace and line breaks.');
  return rules.join(' ');
}
