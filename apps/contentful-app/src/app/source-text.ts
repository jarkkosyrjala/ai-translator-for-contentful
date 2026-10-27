import type { ContentTypeField } from '@contentful/app-sdk';
import { isRichDocument, richTextFieldError, richTextPlanningError } from '../richtext/editor';

/**
 * Why a field's source value cannot be translated: `empty` when it has no
 * text other than whitespace, a message when it has text the app cannot send,
 * or undefined when it can be translated. Rich Text that already breaks the
 * field's rules is refused before a model call, since every suggestion built
 * from it would break them too.
 */
export function sourceProblem(
  value: unknown,
  kind: 'text' | 'array' | 'richText',
  field?: ContentTypeField,
): 'empty' | string | undefined {
  if (kind === 'text') return typeof value === 'string' && value.trim() ? undefined : 'empty';
  if (kind === 'array') {
    if (!Array.isArray(value) || !value.some(item => typeof item === 'string' && item.trim())) return 'empty';
    return value.every(item => typeof item === 'string') ? undefined : 'The list has items that are not text.';
  }
  if (!isRichDocument(value) || !hasRichText(value)) return 'empty';
  const planning = richTextPlanningError(value);
  if (planning) return `${planning}.`;
  const fieldError = field && richTextFieldError(value, field);
  return fieldError ? `${fieldError}. Fix the source before translating.` : undefined;
}

function hasRichText(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if ('value' in node && typeof node.value === 'string' && node.value.trim()) return true;
  return 'content' in node && Array.isArray(node.content) && node.content.some(hasRichText);
}
