import type { ContentTypeField } from '@contentful/app-sdk';
import { relayChoicesError } from './choices';
import type { EditorSnapshot } from './editor-snapshot';
import { eligibility } from './eligibility';
import { functionReadinessError } from './function-config';
import { backendUrlError } from './setup-model';
import { sourceProblem } from './source-text';
import type { Params } from './transport-config';

export type ApplyLine = { key: string; status: string; detail?: string };

// Saved settings that can translate: a Function with its models and default,
// or a backend URL with a valid choice list that contains the default.
export function isConfigured(params: Params): boolean {
  if (params.transport === 'function') return !functionReadinessError(params);
  return Boolean(
    (params.backendUrl ?? '').trim() && !backendUrlError(params.backendUrl ?? '') && !relayChoicesError(params),
  );
}

export function readyFieldCount(snapshot: EditorSnapshot, sourceLocale: string): number {
  if (snapshot.locales.filter(locale => locale !== sourceLocale).length === 0) return 0;
  return snapshot.definitions.filter(field => {
    const result = eligibility(field, snapshot.controls);
    return result.eligible && !sourceProblem(snapshot.fields[field.id]?.[sourceLocale], result.kind, field);
  }).length;
}

function languageList(locales: string[], names: Record<string, string>): string {
  const labels = locales.map(locale => names[locale] || locale);
  if (labels.length < 2) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

export function readinessLine(snapshot: EditorSnapshot, names: Record<string, string>): string {
  const source =
    snapshot.focusedLocale && snapshot.locales.includes(snapshot.focusedLocale)
      ? snapshot.focusedLocale
      : snapshot.defaultLocale;
  const count = readyFieldCount(snapshot, source);
  const targets = snapshot.locales.filter(locale => locale !== source);
  return `${count} ${count === 1 ? 'field' : 'fields'} can be translated into ${languageList(targets, names)}.`;
}

const reasons: Record<string, string> = {
  applied: 'written',
  kept: 'kept current',
  conflict: 'not written, the source or target changed in the editor',
  invalid: 'not written, the suggestion did not meet the field rules',
  denied: 'not written, editing is not permitted',
  disabled: 'not written, this field is disabled',
  failed: 'not written, the draft update failed',
  generation_failed: 'not written, a suggestion could not be generated',
  cancelled: 'not written, generation was cancelled',
  not_generated: 'not written, no suggestion was generated',
};

export function outcomeLine(
  line: ApplyLine,
  definitions: ContentTypeField[],
  localeNames: Record<string, string>,
): string {
  const separator = line.key.lastIndexOf(':');
  const fieldId = separator < 0 ? line.key : line.key.slice(0, separator);
  const locale = separator < 0 ? '' : line.key.slice(separator + 1);
  const field = definitions.find(item => item.id === fieldId)?.name ?? fieldId;
  const language = localeNames[locale] || locale;
  const reason =
    line.status === 'conflict'
      ? `not written, ${language} changed in the editor`
      : (reasons[line.status] ?? 'not written');
  return `${field} · ${language} · ${reason}`;
}

// One notification for a run started from a field. Kept values are a choice
// the editor made, so only values that could not be written are listed.
export function outcomeNotice(
  lines: ApplyLine[],
  definitions: ContentTypeField[],
  localeNames: Record<string, string>,
): { variant: 'success' | 'warning'; message: string } | undefined {
  if (!lines.length) return undefined;
  const applied = lines.filter(line => line.status === 'applied').length;
  const problems = lines.filter(line => line.status !== 'applied' && line.status !== 'kept');
  const summary = `${applied} ${applied === 1 ? 'value' : 'values'} written to the draft. Nothing was published.`;
  return problems.length
    ? {
        variant: 'warning',
        message: `${summary} ${problems.map(line => outcomeLine(line, definitions, localeNames)).join('; ')}.`,
      }
    : { variant: 'success', message: summary };
}
