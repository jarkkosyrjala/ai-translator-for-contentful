import type { ContentTypeField } from '@contentful/app-sdk';
import type { Document } from '@contentful/rich-text-types';
import { isRichDocument, richTextReviewValidation } from '../richtext/editor';
import { type ReferenceContext, richTextReferenceError } from '../richtext/references';
import { type ArrayLimits, arrayIntegrityError, assembleArraySuggestion, planArrayItems } from './arrays';
import { textIntegrityError } from './placeholders';

export interface DraftFieldPort {
  read(locale: string): unknown;
  isDisabled(locale: string): boolean;
  write(value: string | string[] | Document, locale: string): Promise<void>;
  // Whether every sibling and context value the suggestion's requests sent
  // still matches the entry.
  dependenciesCurrent(): boolean;
}
export type DraftOutcome = {
  status: 'applied' | 'kept' | 'conflict' | 'invalid' | 'disabled' | 'denied';
  detail?: string;
};
export interface DraftTextSelection {
  sourceLocale: string;
  targetLocale: string;
  sourceSnapshot: unknown;
  targetSnapshot: unknown;
  suggestion: string;
  choice: 'keep' | 'suggestion';
  size?: { min?: number; max?: number };
  // The editor approved this suggestion's changed protected text.
  warningApproved?: boolean;
}
export interface DraftArraySelection extends Omit<DraftTextSelection, 'suggestion' | 'size'> {
  suggestion: string[];
  limits?: ArrayLimits;
}
export interface DraftRichSelection extends Omit<DraftTextSelection, 'suggestion' | 'size'> {
  suggestion: Document;
  definition: ContentTypeField;
}
// A field rule violation blocks a suggestion. Changed placeholders, URLs,
// identifiers or edge whitespace are a warning the editor may approve.
export type SuggestionValidation = { error?: string; warning?: string };

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// The source, the target and every value the suggestion depends on are
// unchanged since generation.
function unchanged(field: DraftFieldPort, selection: Omit<DraftTextSelection, 'suggestion'>): boolean {
  return (
    same(field.read(selection.sourceLocale), selection.sourceSnapshot) &&
    same(field.read(selection.targetLocale), selection.targetSnapshot) &&
    field.dependenciesCurrent()
  );
}
const CONFLICT: DraftOutcome = { status: 'conflict', detail: 'Source, target or context changed during review' };

const blocked = (validation: SuggestionValidation, approved?: boolean) =>
  validation.error ?? (approved ? undefined : validation.warning);

export function textSuggestionValidation(
  source: string,
  suggestion: string,
  size?: DraftTextSelection['size'],
): SuggestionValidation {
  const length = [...suggestion].length;
  if (!suggestion || (size?.min !== undefined && length < size.min) || (size?.max !== undefined && length > size.max))
    return { error: 'Suggested text violates the field size rule' };
  const warning = textIntegrityError(source, suggestion);
  return warning ? { warning } : {};
}

export async function applyTextDraft(
  field: DraftFieldPort,
  selection: DraftTextSelection,
  mayUpdate: () => Promise<boolean>,
): Promise<DraftOutcome> {
  if (selection.choice === 'keep') return { status: 'kept' };
  if (!unchanged(field, selection)) return CONFLICT;
  if (field.isDisabled(selection.targetLocale)) return { status: 'disabled' };
  if (!(await mayUpdate())) return { status: 'denied' };
  if (typeof selection.sourceSnapshot !== 'string') return { status: 'invalid', detail: 'Source is not text' };
  const validation = blocked(
    textSuggestionValidation(selection.sourceSnapshot, selection.suggestion, selection.size),
    selection.warningApproved,
  );
  if (validation) return { status: 'invalid', detail: validation };
  // One final check after the asynchronous permission call narrows the race before setValue.
  if (!unchanged(field, selection)) return CONFLICT;
  await field.write(selection.suggestion, selection.targetLocale);
  return { status: 'applied' };
}

export function arraySuggestionValidation(
  source: unknown,
  suggestion: string[],
  limits?: ArrayLimits,
): SuggestionValidation {
  try {
    const items = planArrayItems(source).map(item => item.text);
    assembleArraySuggestion(
      items,
      suggestion.map((text, index) => ({ index, text })),
      limits,
    );
    const warning = arrayIntegrityError(items, suggestion);
    return warning ? { warning } : {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid array suggestion' };
  }
}

export async function applyArrayDraft(
  field: DraftFieldPort,
  selection: DraftArraySelection,
  mayUpdate: () => Promise<boolean>,
): Promise<DraftOutcome> {
  if (selection.choice === 'keep') return { status: 'kept' };
  if (!unchanged(field, selection)) return CONFLICT;
  if (field.isDisabled(selection.targetLocale)) return { status: 'disabled' };
  if (!(await mayUpdate())) return { status: 'denied' };
  const validation = blocked(
    arraySuggestionValidation(selection.sourceSnapshot, selection.suggestion, selection.limits),
    selection.warningApproved,
  );
  if (validation) return { status: 'invalid', detail: validation };
  if (!unchanged(field, selection)) return CONFLICT;
  await field.write(selection.suggestion, selection.targetLocale);
  return { status: 'applied' };
}

export async function applyRichDraft(
  field: DraftFieldPort,
  selection: DraftRichSelection,
  mayUpdate: () => Promise<boolean>,
  references?: ReferenceContext,
): Promise<DraftOutcome> {
  if (selection.choice === 'keep') return { status: 'kept' };
  if (!unchanged(field, selection)) return CONFLICT;
  if (field.isDisabled(selection.targetLocale)) return { status: 'disabled' };
  if (!(await mayUpdate())) return { status: 'denied' };
  if (!isRichDocument(selection.sourceSnapshot)) return { status: 'invalid', detail: 'Source is not Rich Text' };
  const suggestion = selection.suggestion;
  try {
    const validation = blocked(
      richTextReviewValidation(selection.sourceSnapshot, suggestion, selection.definition),
      selection.warningApproved,
    );
    if (validation) return { status: 'invalid', detail: validation };
  } catch (error) {
    return { status: 'invalid', detail: error instanceof Error ? error.message : String(error) };
  }
  const referenceError = await richTextReferenceError(suggestion, selection.definition, references);
  if (referenceError) return { status: 'invalid', detail: referenceError };
  if (!unchanged(field, selection)) return CONFLICT;
  await field.write(suggestion, selection.targetLocale);
  return { status: 'applied' };
}
