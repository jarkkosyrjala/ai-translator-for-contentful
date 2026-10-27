import type { ContentTypeField, EditorInterface } from '@contentful/app-sdk';

export type Eligibility =
  | {
      eligible: true;
      kind: 'text' | 'array' | 'richText';
      size?: { min?: number; max?: number };
      itemSize?: { min?: number; max?: number };
    }
  | { eligible: false; reason: string };
const textControls = new Set(['singleLine', 'multipleLine', 'markdown', 'urlEditor']);
const arrayControls = new Set(['listInput', 'tagEditor']);
const richControls = new Set(['richTextEditor']);
// Built-in editors the app can render at the entry field location, in the
// order of Contentful's default for the field type.
const fieldAppEditors: Record<string, string[]> = {
  Symbol: ['singleLine'],
  Text: ['markdown', 'multipleLine', 'singleLine'],
  RichText: ['richTextEditor'],
  Symbols: ['tagEditor', 'listInput'],
};

// The `editor` instance parameter picks the built-in editor. Values that do not
// fit the field type fall back to Contentful's default editor for that type.
export function fieldAppEditor(
  field: Pick<ContentTypeField, 'type' | 'items'>,
  settings?: Record<string, unknown>,
): string | undefined {
  const editors = fieldAppEditors[field.type === 'Array' && field.items?.type === 'Symbol' ? 'Symbols' : field.type];
  if (!editors) return undefined;
  return typeof settings?.editor === 'string' && editors.includes(settings.editor) ? settings.editor : editors[0];
}

// Fields that use this app as their editor keep the built-in editor it renders,
// so the rest of the app treats them like any other field with that editor.
export function resolveAppControls(
  controls: EditorInterface['controls'],
  fields: ContentTypeField[],
  appId: string | undefined,
): EditorInterface['controls'] {
  if (!appId) return controls;
  return controls?.map(control => {
    if (control.widgetNamespace !== 'app' || control.widgetId !== appId) return control;
    const field = fields.find(item => item.id === control.fieldId);
    const widgetId = field && fieldAppEditor(field, control.settings);
    return widgetId ? { ...control, widgetNamespace: 'builtin' as const, widgetId } : control;
  });
}

function restricted(validations: ContentTypeField['validations']): boolean {
  return (validations ?? []).some(
    rule => rule.in !== undefined || rule.regexp !== undefined || rule.prohibitRegexp !== undefined,
  );
}
function size(validations: ContentTypeField['validations'], technicalMax: number) {
  const configured = (validations ?? []).find(rule => rule.size)?.size;
  return { min: configured?.min, max: Math.min(configured?.max ?? technicalMax, technicalMax) };
}

export function eligibility(field: ContentTypeField, controls: EditorInterface['controls']): Eligibility {
  if (!field.localized) return { eligible: false, reason: 'Field is not localized' };
  if (field.disabled || field.omitted || field.deleted)
    return { eligible: false, reason: 'Field is disabled or unavailable' };
  const control = controls?.find(item => item.fieldId === field.id);
  if (control?.widgetNamespace && control.widgetNamespace !== 'builtin')
    return { eligible: false, reason: 'Custom editor behavior is unknown' };
  if (restricted(field.validations) || restricted(field.items?.validations))
    return { eligible: false, reason: 'Predefined values or regular-expression validation' };
  if (field.type === 'Symbol' || field.type === 'Text') {
    if (control?.widgetId && !textControls.has(control.widgetId))
      return { eligible: false, reason: `Option-only or unsupported editor: ${control.widgetId}` };
    return { eligible: true, kind: 'text', size: size(field.validations, field.type === 'Symbol' ? 256 : 50_000) };
  }
  if (field.type === 'Array' && field.items?.type === 'Symbol') {
    if (!control?.widgetId) return { eligible: false, reason: 'Free-text array editor has not been verified' };
    if (!arrayControls.has(control.widgetId))
      return { eligible: false, reason: `Option-only or unsupported array editor: ${control.widgetId}` };
    return {
      eligible: true,
      kind: 'array',
      size: size(field.validations, 1_000),
      itemSize: size(field.items.validations, 256),
    };
  }
  if (field.type === 'RichText') {
    if (control?.widgetId && !richControls.has(control.widgetId))
      return { eligible: false, reason: `Unsupported Rich Text editor: ${control.widgetId}` };
    return { eligible: true, kind: 'richText', size: size(field.validations, 200_000) };
  }
  return { eligible: false, reason: `Unsupported field type: ${field.type}` };
}
