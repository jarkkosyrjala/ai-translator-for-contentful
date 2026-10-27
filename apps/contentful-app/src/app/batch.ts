import type { ContentTypeField } from '@contentful/app-sdk';
import type { Document } from '@contentful/rich-text-types';
import type { EditorSnapshot } from './editor-snapshot';
import { eligibility, fieldAppEditor } from './eligibility';
import { sourceProblem } from './source-text';

// One field into one target locale, frozen from the run snapshot.
export type Task = {
  key: string;
  entryId: string;
  fieldId: string;
  fieldName: string;
  kind: 'text' | 'array' | 'richText';
  // Authoring format of text; the model response still carries a string.
  format?: 'markdown';
  // Long text may be split at paragraph boundaries; Short text never is.
  longText: boolean;
  // The field's position in the content type, the packing order.
  order: number;
  sourceLocale: string;
  targetLocale: string;
  sourceSnapshot: string | string[] | Document;
  targetSnapshot: unknown;
  size?: { min?: number; max?: number };
  itemSize?: { min?: number; max?: number };
  definition: ContentTypeField;
};
// A value whose result depends on it: the field, locale and frozen value.
export type Dependency = { fieldId: string; locale: string; value: unknown };
export type TaskResult = {
  task: Task;
  status: 'ready' | 'error' | 'cancelled';
  suggestion?: string | string[] | Document;
  provider?: 'mock' | 'openai-compatible';
  profileRevision?: string;
  detail?: string;
  // The failure code, which decides the retry actions.
  code?: string;
  // What the provider sent with a failure, from a relay in debug mode.
  debug?: string;
  // Parseable model content the frontend could not safely reconstruct.
  rawSuggestion?: string;
  // An editable warning that does not block Use.
  warning?: string;
  dependencies?: Dependency[];
};

export function planTasks(
  snapshot: EditorSnapshot,
  fieldIds: string[],
  sourceLocale: string,
  targetLocales: string[],
): Task[] {
  const selected = new Set(fieldIds);
  const tasks: Task[] = [];
  for (const [order, field] of snapshot.definitions.entries()) {
    if (!selected.has(field.id)) continue;
    const result = eligibility(field, snapshot.controls);
    if (!result.eligible) continue;
    const source = snapshot.fields[field.id]?.[sourceLocale];
    if (sourceProblem(source, result.kind, field)) continue;
    const editor = snapshot.controls?.find(control => control.fieldId === field.id)?.widgetId ?? fieldAppEditor(field);
    for (const targetLocale of targetLocales) {
      if (targetLocale === sourceLocale || !snapshot.locales.includes(targetLocale)) continue;
      tasks.push({
        key: `${field.id}:${targetLocale}`,
        entryId: snapshot.entryId,
        fieldId: field.id,
        fieldName: field.name,
        kind: result.kind,
        ...(result.kind === 'text' && editor === 'markdown' ? { format: 'markdown' as const } : {}),
        longText: field.type === 'Text',
        order,
        sourceLocale,
        targetLocale,
        sourceSnapshot: structuredClone(source as string | string[] | Document),
        targetSnapshot: structuredClone(snapshot.fields[field.id]?.[targetLocale] ?? null),
        size: result.size,
        itemSize: result.itemSize,
        definition: field,
      });
    }
  }
  return tasks;
}
