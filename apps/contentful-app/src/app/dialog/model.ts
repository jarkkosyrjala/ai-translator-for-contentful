import type { ContentTypeField } from '@contentful/app-sdk';
import type { Document } from '@contentful/rich-text-types';
import { richTextReviewValidation } from '../../richtext/editor';
import type { Dependency, Task, TaskResult } from '../batch';
import { CHOICE_UNAVAILABLE } from '../choices';
import { arraySuggestionValidation, type SuggestionValidation, textSuggestionValidation } from '../draft';
import type { EditorSnapshot } from '../editor-snapshot';
import { eligibility } from '../eligibility';
import { sourceProblem } from '../source-text';

export type Review = TaskResult & {
  choice: 'keep' | 'suggestion';
  // The generated suggestion, which Restore generated text brings back.
  originalSuggestion?: string | string[] | Document;
  editorRevision?: number;
  // The exact suggestion whose warning the editor approved.
  approvedJson?: string;
  // Identifies the attempts the result came from, so a new result replaces
  // the review and an unchanged one keeps the editor's edits.
  attempt?: string;
};

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Whether every value a result depends on still matches the editor.
export function dependenciesCurrent(
  dependencies: readonly Dependency[],
  snapshot: EditorSnapshot | undefined,
): boolean {
  return Boolean(
    snapshot && dependencies.every(item => sameValue(snapshot.fields[item.fieldId]?.[item.locale], item.value)),
  );
}

// A task's own source and target, and for a result every sibling and context
// value its requests sent.
export function isCurrent(item: Task | TaskResult, snapshot: EditorSnapshot | undefined): boolean {
  const task = 'task' in item ? item.task : item;
  return Boolean(
    snapshot &&
      sameValue(snapshot.fields[task.fieldId]?.[task.sourceLocale], task.sourceSnapshot) &&
      sameValue(snapshot.fields[task.fieldId]?.[task.targetLocale], task.targetSnapshot) &&
      ('task' in item ? dependenciesCurrent(item.dependencies ?? [], snapshot) : true),
  );
}

function reviewValidation(review: Review): SuggestionValidation {
  if (review.status !== 'ready' || review.suggestion === undefined) return { error: 'No generated suggestion' };
  if (review.task.kind === 'text')
    return textSuggestionValidation(
      review.task.sourceSnapshot as string,
      review.suggestion as string,
      review.task.size,
    );
  if (review.task.kind === 'array')
    return arraySuggestionValidation(review.task.sourceSnapshot, review.suggestion as string[], {
      count: review.task.size,
      item: review.task.itemSize,
    });
  if (review.detail) return { error: review.detail };
  if (!review.task.definition) return { error: 'Missing Rich Text field definition' };
  return richTextReviewValidation(review.task.sourceSnapshot, review.suggestion, review.task.definition);
}

export function suggestionError(review: Review): string | undefined {
  const validation = reviewValidation(review);
  return validation.error ?? (validation.warning && !warningApproved(review) ? validation.warning : undefined);
}

// Changed protected text the editor may approve, for a suggestion without errors.
export function suggestionWarning(review: Review): string | undefined {
  if (review.status !== 'ready') return undefined;
  const validation = reviewValidation(review);
  return validation.error ? undefined : validation.warning;
}

export function warningApproved(review: Review): boolean {
  return Boolean(review.approvedJson && review.approvedJson === JSON.stringify(review.suggestion));
}

// Whether the editor changed the generated suggestion.
export function suggestionEdited(review: Review): boolean {
  return review.originalSuggestion !== undefined && !sameValue(review.suggestion, review.originalSuggestion);
}

export function localeName(locale: string, names: Record<string, string> | undefined): string {
  return names?.[locale] || locale;
}

export function taskDefinition(task: Task, _snapshot?: EditorSnapshot): ContentTypeField {
  return task.definition;
}

export function fieldTypeLabel(field: ContentTypeField, value: unknown, widgetId?: string): string {
  if (field.type === 'RichText') return 'Rich text';
  if (field.type === 'Array') return `List of ${Array.isArray(value) ? value.length : 0}`;
  if (widgetId === 'markdown') return 'Markdown';
  if (widgetId === 'singleLine') return 'Short text';
  if (widgetId === 'urlEditor') return 'URL';
  return field.type === 'Symbol' ? 'Short text' : 'Long text';
}

function richTextPlain(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as { value?: unknown; content?: unknown };
  if (typeof node.value === 'string') return node.value;
  return Array.isArray(node.content) ? node.content.map(richTextPlain).filter(Boolean).join(' ') : '';
}

export function fieldPreview(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.filter(item => typeof item === 'string').join(', ')
        : richTextPlain(value);
  return text.replace(/\s+/g, ' ').trim();
}

// Whether a field value has anything to show. An empty Rich Text document
// holds an empty paragraph; embeds and rules count as content.
export function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== 'object') return false;
  const node = value as { nodeType?: string; value?: unknown; content?: unknown };
  if (node.nodeType === 'text') return hasContent(node.value);
  if (node.nodeType === 'hr' || node.nodeType?.startsWith('embedded-')) return true;
  return Array.isArray(node.content) && node.content.some(hasContent);
}

export function selectableFields(snapshot: EditorSnapshot, source: string) {
  return snapshot.definitions.filter(field => !fieldSourceProblem(snapshot, field, source));
}

// Why a field cannot be translated from `source`; see sourceProblem.
export function fieldSourceProblem(
  snapshot: EditorSnapshot,
  field: ContentTypeField,
  source: string,
): 'ineligible' | 'empty' | string | undefined {
  const result = eligibility(field, snapshot.controls);
  if (!result.eligible) return 'ineligible';
  return sourceProblem(snapshot.fields[field.id]?.[source], result.kind, field);
}

// A launch from a field fixes the field and the locale to translate from while
// the entry still has both and the field can be translated.
export function launchedField(
  snapshot: EditorSnapshot,
  fieldId: unknown,
  locale: unknown,
): { field: ContentTypeField; locale: string } | undefined {
  if (typeof fieldId !== 'string' || typeof locale !== 'string' || !snapshot.locales.includes(locale)) return undefined;
  const field = snapshot.definitions.find(item => item.id === fieldId);
  return field && eligibility(field, snapshot.controls).eligible ? { field, locale } : undefined;
}

export function canShowRequestDetails(debugMode: unknown): boolean {
  return debugMode === true;
}

export function usableReview(
  review: Review | undefined,
  snapshot: EditorSnapshot | undefined,
  usableProvider: (provider: TaskResult['provider']) => boolean,
  profileRevision?: string,
): boolean {
  return Boolean(
    review &&
      review.status === 'ready' &&
      usableProvider(review.provider) &&
      !suggestionError(review) &&
      isCurrent(review, snapshot) &&
      (!profileRevision || review.profileRevision === profileRevision),
  );
}

export function reviewFromResult(
  result: TaskResult,
  snapshot: EditorSnapshot | undefined,
  usableProvider: (provider: TaskResult['provider']) => boolean,
  profileRevision?: string,
): Review {
  const review: Review = {
    ...result,
    choice: 'keep',
    originalSuggestion: result.suggestion === undefined ? undefined : structuredClone(result.suggestion),
  };
  return { ...review, choice: usableReview(review, snapshot, usableProvider, profileRevision) ? 'suggestion' : 'keep' };
}

export function restoreGeneratedSuggestion(
  review: Review,
  snapshot: EditorSnapshot | undefined,
  usableProvider: (provider: TaskResult['provider']) => boolean,
  profileRevision?: string,
): Review {
  if (!review.originalSuggestion) return review;
  const restored: Review = {
    ...review,
    suggestion: structuredClone(review.originalSuggestion),
    detail: undefined,
    editorRevision: (review.editorRevision ?? 0) + 1,
    approvedJson: undefined,
    choice: 'keep',
  };
  return {
    ...restored,
    choice: usableReview(restored, snapshot, usableProvider, profileRevision) ? 'suggestion' : 'keep',
  };
}

export function applySummary(
  tasks: Task[],
  reviews: Record<string, Review>,
  snapshot: EditorSnapshot | undefined,
  usableProvider: (provider: TaskResult['provider']) => boolean,
  profileRevision?: string,
) {
  const applicable = tasks.filter(
    task =>
      reviews[task.key]?.choice === 'suggestion' &&
      usableReview(reviews[task.key], snapshot, usableProvider, profileRevision),
  );
  return { count: applicable.length, keys: applicable.map(task => task.key) };
}

/**
 * What the sidebar reports for a task Apply does not write. A suggestion the
 * editor chose that can no longer be applied, because it went stale or does
 * not meet the field rules, is a conflict or invalid, never kept.
 */
export function unappliedOutcome(
  review: Review | undefined,
  snapshot: EditorSnapshot | undefined,
): { status: string; detail?: string } {
  if (review?.status === 'error') return { status: 'generation_failed', detail: review.detail };
  if (review?.status === 'cancelled') return { status: 'cancelled' };
  if (review?.status !== 'ready') return { status: 'not_generated' };
  if (review.choice !== 'suggestion') return { status: 'kept' };
  const error = suggestionError(review);
  if (error) return { status: 'invalid', detail: error };
  if (!isCurrent(review, snapshot)) return { status: 'conflict' };
  return { status: 'invalid', detail: 'The suggestion came from settings that are no longer available.' };
}

export function chooseSuggestionsInTab(
  tasks: Task[],
  reviews: Record<string, Review>,
  locale: string,
  snapshot: EditorSnapshot | undefined,
  usableProvider: (provider: TaskResult['provider']) => boolean,
  profileRevision?: string,
): Record<string, Review> {
  const next = { ...reviews };
  for (const task of tasks)
    if (task.targetLocale === locale && usableReview(next[task.key], snapshot, usableProvider, profileRevision))
      next[task.key] = { ...next[task.key], choice: 'suggestion' };
  return next;
}

// Plain explanations of whole-request and field failures.
const codeCopy: Record<string, string> = {
  provider_timeout: 'The model did not finish in time.',
  provider_truncated: 'The model’s answer was cut off before it was complete.',
  provider_incomplete: 'The model’s answer ended early.',
  provider_request_too_large: 'The model rejected the request as too large.',
  request_too_large: 'The request is larger than the translation service accepts.',
  result_too_large: 'The answer is larger than the translation service can return.',
  provider_refused: 'The model declined to translate this content.',
  provider_rate_limited: 'The model is rate limiting requests. Wait a moment and retry.',
  invalid_provider_response: 'The model’s answer could not be read.',
  missing: 'The model’s answer left out this field.',
  empty: 'The model returned this field empty.',
  invalid_items: 'The model changed this list’s items.',
  invalid_structure: 'The model changed this field’s structure.',
  stale: 'The source or other sent values changed in the editor before this was sent. Translate again from the start.',
  too_long: 'The suggestion is more than twice the field’s maximum length.',
  unsupported_contract: 'The translation service runs another app version. Ask an administrator to update the backend.',
  coverage: 'The parts of this field did not fit together.',
};

export function failureCopy(review: Pick<Review, 'code' | 'detail'>): string {
  if (review.code && codeCopy[review.code]) return codeCopy[review.code];
  return plainError(review.detail);
}

export function plainError(detail: string | undefined): string {
  const value = detail ?? '';
  // Generated Rich Text can fail the same structural/locked-content guard as
  // an edited suggestion. Show that specific, safe reason instead of blaming
  // the translation service.
  const richTextFailure = value.match(
    /^(A link changed|An embedded item changed|A horizontal rule changed|Code text changed|A line break changed|Suggested text changed (?:placeholders|URLs|identifiers)|The Rich Text document has an invalid structure|The Rich Text document is unavailable)/i,
  );
  if (richTextFailure) return `${richTextFailure[1]}. Retry this field.`;
  // The backend no longer allows the chosen provider or model. Retrying with
  // another choice is the editor's decision, so say so plainly.
  if (value.includes(CHOICE_UNAVAILABLE) || /provider_not_allowed|model_not_allowed/.test(value))
    return CHOICE_UNAVAILABLE;
  if (/Editor values changed/i.test(value))
    return 'The source or current translation changed in the editor. Translate again to include the latest value.';
  if (/concurrency_limit/i.test(value))
    return 'Another translation for this entry is still running. Retry this field when it finishes.';
  if (/invalid_signature|unauthorized|\b401\b/i.test(value))
    return 'The translation service could not verify this app. Ask an administrator to check the connection.';
  if (/forbidden|\b403\b/i.test(value))
    return 'This app is not allowed to use the translation service. Ask an administrator to check its settings.';
  if (/provider|model|upstream/i.test(value))
    return 'The translation service could not complete this field. Retry it, or ask an administrator to check the model.';
  if (/size|too.large|\b413\b/i.test(value))
    return 'This text is too large for one request. Shorten the source or remove some context.';
  if (/fetch|network|timeout|unreachable/i.test(value))
    return 'The translation service could not be reached. Check the connection and retry.';
  return 'This field could not be translated. Retry it or ask an administrator to check the translation service.';
}

export function validationCopy(review: Review): string | undefined {
  const error = suggestionError(review);
  const warning = suggestionWarning(review);
  if (warning)
    return `${warning}. Review the change carefully before using this ${review.task.kind === 'richText' ? 'Rich Text' : 'suggestion'}.`;
  if (!error) return undefined;
  if (review.task.kind === 'richText') {
    if (/embedded item|reference|(?:anchor|locked ID).*r\d+/i.test(error))
      return 'An embedded item changed. Restore the generated text to use it.';
    if (/link|(?:anchor|locked ID).*l\d+/i.test(error)) return 'A link changed. Restore the generated text to use it.';
    if (/placeholder/i.test(error)) return 'A placeholder changed. Restore it to use this suggestion.';
    if (/line break/i.test(error)) return 'A line break changed. Restore the generated text to use it.';
    if (/code text/i.test(error)) return 'Code text changed. Restore the generated text to use it.';
    if (/invalid structure/i.test(error))
      return 'This Rich Text has an invalid structure. Restore the generated text or translate again.';
    if (/field (?:size|rule)|disabled by this field|count violates/i.test(error))
      return `${error}. Correct the text or translate again.`;
    if (/changed URLs/i.test(error)) return 'A URL in the text changed. Restore the generated text to use it.';
    if (/changed identifiers/i.test(error))
      return 'An identifier in the text changed. Restore the generated text to use it.';
    return 'A locked part of this Rich Text changed. Undo the edit or correct the text to use it.';
  }
  if (
    review.task.kind === 'text' &&
    typeof review.suggestion === 'string' &&
    review.task.size?.max !== undefined &&
    [...review.suggestion].length > review.task.size.max
  ) {
    return `${[...review.suggestion].length} of ${review.task.size.max} characters. Shorten it to use it.`;
  }
  if (
    review.task.kind === 'text' &&
    typeof review.suggestion === 'string' &&
    review.task.size?.min !== undefined &&
    [...review.suggestion].length < review.task.size.min
  ) {
    return `At least ${review.task.size.min} characters are needed. Add text to use it.`;
  }
  return error;
}
