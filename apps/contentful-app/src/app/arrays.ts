import { textIntegrityError } from './placeholders';

export interface ArraySuggestion {
  index: number;
  text: string;
}
export interface ArrayLimits {
  count?: { min?: number; max?: number };
  item?: { min?: number; max?: number };
}

export function planArrayItems(source: unknown): { index: number; text: string }[] {
  if (!Array.isArray(source) || !source.every(item => typeof item === 'string'))
    throw new Error('Source is not a string array');
  return source.map((text, index) => ({ index, text }));
}

export function assembleArraySuggestion(
  source: string[],
  results: ArraySuggestion[],
  limits: ArrayLimits = {},
): string[] {
  if (results.length !== source.length || new Set(results.map(result => result.index)).size !== source.length)
    throw new Error('Missing or duplicate array item');
  if (
    (limits.count?.min !== undefined && results.length < limits.count.min) ||
    (limits.count?.max !== undefined && results.length > limits.count.max)
  )
    throw new Error('Array count violates field size rule');
  const output = new Array<string>(source.length);
  for (const result of results) {
    if (!Number.isInteger(result.index) || result.index < 0 || result.index >= source.length)
      throw new Error('Unexpected array item index');
    if (typeof result.text !== 'string') throw new Error('Array item must be text');
    const length = [...result.text].length;
    if (
      (limits.item?.min !== undefined && length < limits.item.min) ||
      (limits.item?.max !== undefined && length > limits.item.max)
    )
      throw new Error(`Array item ${result.index} violates size rule`);
    output[result.index] = result.text;
  }
  return output;
}

// The first item whose placeholders, URLs, identifiers or edge whitespace
// differ from its source item.
export function arrayIntegrityError(source: string[], suggestion: string[]): string | undefined {
  for (const [index, text] of suggestion.entries()) {
    const integrity = textIntegrityError(source[index], text);
    if (integrity) return `Array item ${index}: ${integrity}`;
  }
}
