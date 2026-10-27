import type { ContentTypeField, DialogAppSDK, FieldAppSDK } from '@contentful/app-sdk';
import type { Document } from '@contentful/rich-text-types';

export type ReviewFieldValue = string | Document;

// Contentful's built-in field editors expect a field location. This adapter gives
// them an in-memory field so editing a suggestion cannot write to the entry.
export function createReviewField(
  dialog: DialogAppSDK,
  entryId: string,
  contentTypeId: string,
  definition: ContentTypeField,
  locale: string,
  initialValue: ReviewFieldValue,
  onChange: (value: ReviewFieldValue) => void,
  instanceParameters: Record<string, unknown> = {},
  readOnly = false,
) {
  let value: ReviewFieldValue = initialValue;
  let changed = onChange;
  let active = true;
  const listeners = new Set<(value: ReviewFieldValue) => void>();
  const emit = () => {
    for (const listener of listeners) listener(value);
  };
  const field = {
    id: definition.id,
    name: definition.name,
    locale,
    type: definition.type,
    required: Boolean(definition.required),
    validations: definition.validations ?? [],
    getValue: () => value,
    setValue: async (next: ReviewFieldValue) => {
      if (!active || readOnly) return undefined;
      value = next;
      emit();
      changed(next);
      return next;
    },
    removeValue: async () => {
      if (!active || readOnly) return;
      value = definition.type === 'RichText' ? ({ nodeType: 'document', data: {}, content: [] } as Document) : '';
      emit();
      changed(value);
    },
    setInvalid: () => undefined,
    onValueChanged: (listener: (value: ReviewFieldValue) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getIsDisabled: () => readOnly,
    onIsDisabledChanged: (listener: (disabled: boolean) => void) => {
      listener(readOnly);
      return () => undefined;
    },
    getSchemaErrors: () => [],
    onSchemaErrorsChanged: (listener: (errors: never[]) => void) => {
      listener([]);
      return () => undefined;
    },
  };
  const sdk = {
    ...dialog,
    ids: { ...dialog.ids, entry: entryId, contentType: contentTypeId, field: definition.id },
    parameters: { ...dialog.parameters, instance: instanceParameters },
    entry: { getSys: () => ({ id: entryId }) },
    field,
  } as unknown as FieldAppSDK;
  return {
    sdk,
    field,
    setOnChange: (next: typeof onChange) => {
      changed = next;
    },
    setExternal: (next: ReviewFieldValue) => {
      if (active) {
        value = next;
        emit();
      }
    },
    dispose: () => {
      active = false;
      listeners.clear();
    },
    // Rich Text and Markdown flush debounced edits while their editor unmounts.
    // Keep the local field alive until that flush reaches the review state.
    disposeAfterPendingChange: () => {
      setTimeout(() => {
        active = false;
        listeners.clear();
      }, 700);
    },
  };
}
