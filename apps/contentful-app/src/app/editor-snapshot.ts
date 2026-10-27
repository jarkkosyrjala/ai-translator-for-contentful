import type { ContentTypeField, EditorInterface, FieldAppSDK, SidebarAppSDK } from '@contentful/app-sdk';
import { resolveAppControls } from './eligibility';

// The entry sidebar and the entry field location both read the open entry.
export type EntryEditorSDK = SidebarAppSDK | FieldAppSDK;

export interface EditorSnapshot {
  entryId: string;
  contentTypeId: string;
  defaultLocale: string;
  locales: string[];
  focusedLocale?: string;
  activeLocales?: string[];
  fields: Record<string, Record<string, unknown>>;
  controls: EditorInterface['controls'];
  definitions: ContentTypeField[];
}

export function capture(sdk: EntryEditorSDK): EditorSnapshot {
  const fields: EditorSnapshot['fields'] = {};
  for (const field of sdk.contentType.fields) {
    fields[field.id] = {};
    for (const locale of sdk.locales.available) {
      if (sdk.entry.fields[field.id]?.locales.includes(locale)) {
        fields[field.id][locale] = sdk.entry.fields[field.id].getValue(locale) ?? null;
      }
    }
  }
  const localeSettings = sdk.editor.getLocaleSettings();
  return {
    entryId: sdk.ids.entry,
    contentTypeId: sdk.ids.contentType,
    defaultLocale: sdk.locales.default,
    locales: sdk.locales.available,
    focusedLocale: localeSettings.focused,
    activeLocales: localeSettings.active,
    fields,
    controls: resolveAppControls(sdk.editor.editorInterface.controls, sdk.contentType.fields, sdk.ids.app),
    definitions: sdk.contentType.fields,
  };
}

export function changedValues(before: EditorSnapshot, after: EditorSnapshot): string[] {
  const changed: string[] = [];
  for (const [field, locales] of Object.entries(before.fields)) {
    for (const [locale, value] of Object.entries(locales)) {
      if (JSON.stringify(value) !== JSON.stringify(after.fields[field]?.[locale])) changed.push(`${field}:${locale}`);
    }
  }
  return changed;
}

// Keep listening for the lifetime of the sidebar. The native editor may call
// setValue after the dialog opens, so a one-shot launch snapshot is insufficient.
export function subscribeToEditorValues(
  sdk: EntryEditorSDK,
  onSnapshot: (snapshot: EditorSnapshot, fieldId: string, locale: string) => void,
): () => void {
  let latest = capture(sdk);
  const unsubscribe: Array<() => void> = [];
  try {
    for (const [fieldId, locales] of Object.entries(latest.fields)) {
      const field = sdk.entry.fields[fieldId];
      for (const [locale] of Object.entries(locales)) {
        unsubscribe.push(
          field.onValueChanged(locale, nextValue => {
            const value = nextValue ?? null;
            if (JSON.stringify(latest.fields[fieldId]?.[locale]) === JSON.stringify(value)) return;
            const next = capture(sdk);
            next.fields[fieldId][locale] = value;
            latest = next;
            onSnapshot(next, fieldId, locale);
          }),
        );
      }
    }
  } catch (error) {
    for (const stop of unsubscribe) stop();
    throw error;
  }
  return () => {
    for (const stop of unsubscribe) stop();
  };
}
